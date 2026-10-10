// General Handyman Solutions — main server.
// Run: npm install && npm start
//
// Serves the public site + portals from ./public, exposes the JSON API under
// /api/*, stores uploads under ./uploads, and drains the campaign outbox
// every 30 seconds in the background.
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { execSync } = require('child_process');
const db = require('./src/db');
const mailer = require('./src/services/mailer');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Behind Render/Docker/any reverse proxy: trust ONE hop so req.ip is the real
// client (rate limits are per visitor, and terms-acceptance IPs are not forgeable
// through a raw x-forwarded-for header).
app.set('trust proxy', 1);

// A rejected promise nobody awaited must be LOGGED, never silently kill the server.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});

// ---- Phase 1 hardening: security headers + structured logging ----
// NOTE: CSP is intentionally OFF for now — the portals use inline <script>
// tags, so script-src 'self' would break the app. Full CSP requires moving
// inline scripts to files (planned follow-up). All other helmet headers apply.
const helmet = require('helmet');
const pino = require('pino');
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: ['req.headers.authorization', 'password', '*.password', '*.password_hash', '*.token', '*.client_secret'],
    censor: '[REDACTED]',
  },
});
app.use(helmet({ contentSecurityPolicy: false }));
app.use((req, res, next) => {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    logger.info({
      // No query string (claim tokens, unsubscribe tokens) and no photo capability tokens in logs.
      method: req.method,
      path: req.originalUrl.split('?')[0].replace(/^\/api\/photos\/.*/, '/api/photos/[redacted]'),
      status: res.statusCode, duration_ms: Math.round(ms * 10) / 10,
    }, 'http_request');
  });
  next();
});

// ---- First boot: NEVER auto-seed demo data into a fresh database ----
// Production path: create the real admin from ADMIN_EMAIL + ADMIN_PASSWORD.
// Demo path: set SEED_DEMO=true to load the demo dataset explicitly.
const boot = (async () => {
// Production guard: without Stripe, accepting a quote would mark the deposit as
// paid with no money collected. Opt out explicitly only for a manual-payments pilot.
if (process.env.NODE_ENV === 'production' && !process.env.STRIPE_SECRET_KEY && process.env.ALLOW_MANUAL_PAYMENTS !== 'true') {
  throw new Error('STRIPE_SECRET_KEY is required in production (set ALLOW_MANUAL_PAYMENTS=true only for a manual-payments pilot).');
}
// PostgreSQL: apply pending schema migrations before serving traffic.
await require('./src/db/migrate')();
try {
  const users = (await db.prepare('SELECT COUNT(*) AS c FROM users').get()).c;
  if (users === 0) {
    if (process.env.SEED_DEMO === 'true') {
      console.log('[boot] SEED_DEMO=true — loading demo seed data…');
      execSync('node src/seed.js', { cwd: __dirname, stdio: 'inherit', env: { ...process.env, SEED_DEMO: 'true' } });
    } else if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
      const bcrypt = require('bcryptjs');
      const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10);
      await db.prepare(
        `INSERT INTO users (name, email, phone, password_hash, role, email_verified)
         VALUES (?,?,?,?,?,1)`
      ).run(
        (process.env.ADMIN_NAME || 'Admin').trim(),
        process.env.ADMIN_EMAIL.trim().toLowerCase(), '', hash, 'admin'
      );
      console.log(`[boot] Admin created: ${process.env.ADMIN_EMAIL.trim().toLowerCase()}`);
    } else {
      console.warn('[boot] Empty database and no admin configured.');
      console.warn('[boot] Set ADMIN_EMAIL + ADMIN_PASSWORD (and optional ADMIN_NAME) to create the admin,');
      console.warn('[boot] or SEED_DEMO=true to load demo data. No demo accounts were created.');
    }
  }
} catch (e) {
  console.error('[boot] First-boot setup failed:', e.message);
}
})();
// A failed boot (bad config, failed migration) must stop the process loudly.
boot.catch((e) => { console.error('[boot] FATAL:', e.message); process.exit(1); });

// Stripe webhooks need the RAW body for signature verification: register the
// raw parser for that exact path BEFORE the JSON parser below.
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ---- Rate limiting (PRO 100%): abuse protection on public endpoints ----
// Auth endpoints: 20 attempts / 15 min per IP. Job intake: 30 / hour per IP.
// AUTH_RATE_LIMIT_MAX lets the test suite raise the cap; production default stays 20.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 20,
  standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});
const intakeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 30,
  standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a bit and try again.' },
});
app.use('/api/auth', authLimiter);
app.post('/api/jobs', intakeLimiter);

// ---- Photo delivery ----
// Multer stores files under random names with no extension, so we resolve the
// real MIME type from the photos table. Filenames are 32-char hex tokens,
// effectively unguessable, which is what keeps them private.
// When S3 is configured, photos live in the bucket and we redirect to a
// short-lived signed URL instead of serving from disk.
app.get('/api/photos/:filename', async (req, res) => {
  try {
    const fname = String(req.params.filename || '');
    if (!/^[a-f0-9]{32}$/.test(fname) && !fname.startsWith('photos/')) {
      return res.status(404).json({ error: 'Photo not found.' });
    }
    const row = await db.prepare('SELECT filename, mime, storage_key, storage_provider FROM photos WHERE filename = ?').get(fname);
    if (!row) return res.status(404).json({ error: 'Photo not found.' });
    const storage = require('./src/services/storage');
    if (row.storage_provider === 's3' && row.storage_key && storage.isConfigured()) {
      const url = await storage.signedReadUrl(row.storage_key, 300);
      return res.redirect(302, url);
    }
    const abs = path.join(__dirname, 'uploads', row.filename);
    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'Photo file missing.' });
    res.type(row.mime || 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=3600');
    res.set('X-Robots-Tag', 'noindex');
    res.sendFile(abs);
  } catch (e) {
    res.status(500).json({ error: 'Could not load photo.' });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    await db.prepare('SELECT 1 AS ok').get();
  } catch (e) {
    return res.status(503).json({ ok: false, error: 'database unavailable' });
  }
  res.json({ ok: true, service: 'general-handyman-solutions', mail_provider: mailer.activeProvider(), from: `${mailer.FROM_NAME} <${mailer.FROM_EMAIL}>` });
});

// Public: current legal terms versions (shown/accepted at checkout & job acceptance).
app.get('/api/terms-versions', (req, res) => {
  const { CLIENT_TERMS_VERSION, CONTRACTOR_TERMS_VERSION } = require('./src/services/terms');
  res.json({ client: CLIENT_TERMS_VERSION, contractor: CONTRACTOR_TERMS_VERSION });
});

// ---- Public: unsubscribe from promotional email ----
// GET shows a confirmation button (mail scanners prefetch links; a GET must not
// unsubscribe anyone). POST performs it — also the target of RFC 8058 one-click.
const unsub = require('./src/services/unsubscribe');
function unsubParams(req) {
  const email = unsub.decodeEmail(req.query.e);
  return { email, ok: !!email && unsub.verify(email, req.query.t) };
}
app.get('/api/unsubscribe', (req, res) => {
  const { email, ok } = unsubParams(req);
  res.type('html').send(ok
    ? `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:Arial,sans-serif;max-width:480px;margin:48px auto;padding:0 16px;">
<h2>Unsubscribe</h2><p>Stop promotional emails to <strong>${email.replace(/</g, '&lt;')}</strong>? You will still get messages about your projects and account.</p>
<form method="POST" action="/api/unsubscribe?e=${encodeURIComponent(req.query.e)}&t=${encodeURIComponent(req.query.t)}"><button style="padding:10px 18px;font-size:16px;">Yes, unsubscribe me</button></form></body>`
    : '<!doctype html><body style="font-family:Arial,sans-serif;max-width:480px;margin:48px auto;"><h2>Invalid link</h2><p>This unsubscribe link is not valid.</p></body>');
});
app.post('/api/unsubscribe', async (req, res) => {
  const { email, ok } = unsubParams(req);
  if (!ok) return res.status(400).type('html').send('<!doctype html><body style="font-family:Arial,sans-serif;max-width:480px;margin:48px auto;"><h2>Invalid link</h2></body>');
  await unsub.suppress(email, 'unsubscribed');
  res.type('html').send('<!doctype html><body style="font-family:Arial,sans-serif;max-width:480px;margin:48px auto;"><h2>You are unsubscribed</h2><p>You will no longer receive promotional emails.</p></body>');
});

// ---- API routes ----
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/trades', require('./src/routes/trades'));
app.use('/api/jobs', require('./src/routes/jobs'));
app.use('/api/quotes', require('./src/routes/quotes'));
app.use('/api/projects', require('./src/routes/projects'));
app.use('/api/contractors', require('./src/routes/contractors'));
app.use('/api/crm', require('./src/routes/crm'));
app.use('/api/campaigns', require('./src/routes/campaigns'));
app.use('/api/reports', require('./src/routes/reports'));
app.use('/api/reviews', require('./src/routes/reviews'));
app.use('/api/referrals', require('./src/routes/referrals'));
app.use('/api/payments', require('./src/routes/payments'));
app.use('/api', require('./src/routes/messages'));

// ---- Static frontend ----
app.use(express.static(path.join(__dirname, 'public')));

// ---- Background: drain the campaign outbox every 30s ----
const { processOutbox } = require('./src/routes/campaigns');
setInterval(() => {
  processOutbox(50).catch(e => console.error('[outbox]', e.message));
}, 30 * 1000);

// ---- 404 for unknown API routes ----
app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API endpoint.' }));

// ---- Global error handler (includes friendly multer messages) ----
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'Each photo must be 5 MB or less.' });
  }
  if (err && err.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({ error: 'You can upload at most 6 photos.' });
  }
  if (err && /Only image files/.test(err.message || '')) {
    return res.status(400).json({ error: err.message });
  }
  console.error('[error]', err && err.stack ? err.stack : err);
  res.status(500).json({ error: 'Something went wrong on our end. Please try again.' });
});

boot.then(() => app.listen(PORT, () => {
  console.log(`General Handyman Solutions listening on http://localhost:${PORT}`);
  console.log(`Mail: provider=${mailer.activeProvider()} from="${mailer.FROM_NAME} <${mailer.FROM_EMAIL}>"`);
  if (mailer.activeProvider() === 'console') {
    console.log('Mail is in LOG mode: campaigns are recorded in email_log, nothing is really sent. See README "Business email setup".');
  }
})).catch(() => { /* boot failure already logged and exiting */ });
