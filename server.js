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

// ---- First boot: NEVER auto-seed demo data into a fresh database ----
// Production path: create the real admin from ADMIN_EMAIL + ADMIN_PASSWORD.
// Demo path: set SEED_DEMO=true to load the demo dataset explicitly.
try {
  const users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (users === 0) {
    if (process.env.SEED_DEMO === 'true') {
      console.log('[boot] SEED_DEMO=true — loading demo seed data…');
      execSync('node src/seed.js', { cwd: __dirname, stdio: 'inherit', env: { ...process.env, SEED_DEMO: 'true' } });
    } else if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
      const bcrypt = require('bcryptjs');
      const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10);
      db.prepare(
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

// Stripe webhooks need the RAW body for signature verification: register the
// raw parser for that exact path BEFORE the JSON parser below.
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ---- Rate limiting (PRO 100%): abuse protection on public endpoints ----
// Auth endpoints: 20 attempts / 15 min per IP. Job intake: 30 / hour per IP.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
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
app.get('/api/photos/:filename', (req, res) => {
  const fname = String(req.params.filename || '');
  if (!/^[a-f0-9]{32}$/.test(fname)) return res.status(404).json({ error: 'Photo not found.' });
  const row = db.prepare('SELECT filename, mime FROM photos WHERE filename = ?').get(fname);
  if (!row) return res.status(404).json({ error: 'Photo not found.' });
  const abs = path.join(__dirname, 'uploads', row.filename);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'Photo file missing.' });
  res.type(row.mime || 'image/jpeg');
  res.sendFile(abs);
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'general-handyman-solutions', mail_provider: mailer.activeProvider(), from: `${mailer.FROM_NAME} <${mailer.FROM_EMAIL}>` });
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
  try { processOutbox(50); } catch (e) { console.error('[outbox]', e.message); }
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

app.listen(PORT, () => {
  console.log(`General Handyman Solutions listening on http://localhost:${PORT}`);
  console.log(`Mail: provider=${mailer.activeProvider()} from="${mailer.FROM_NAME} <${mailer.FROM_EMAIL}>"`);
  if (mailer.activeProvider() === 'console') {
    console.log('Mail is in LOG mode: campaigns are recorded in email_log, nothing is really sent. See README "Business email setup".');
  }
});
