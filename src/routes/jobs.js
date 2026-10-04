// Job requests: public intake, photo upload (with vision hook), real estimation.
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { ah, authRequired, optionalAuth, requireRole, isEmail, isPhone, isNonEmpty, failIfErrors } = require('../middleware');
const { TRADES, estimateJob } = require('../services/estimator');
const vision = require('../services/vision');
const photoSvc = require('../services/photos');
const { touchInteraction, refreshLeadScore } = require('../services/crm');

const router = express.Router();
// Public intake routes serve guests (claim token) AND logged-in users.
router.use(optionalAuth);

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 5 * 1024 * 1024, files: 6 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed (max 5 MB each).'));
  },
});

function publicJob(j) {
  const { claim_token, ...rest } = j;
  return rest;
}

// Who may see/modify a job: owner customer, assigned contractor (via project), or admin.
// Guests use the claim token returned at creation (?claim=...).
function canAccess(req, job) {
  if (!req.user && req.query.claim && job.claim_token && req.query.claim === job.claim_token) return true;
  if (!req.user) return false;
  if (req.user.role === 'admin') return true;
  if (job.customer_id && job.customer_id === req.user.id) return true;
  return false;
}
function loadJob(req, res) {
  const job = db.prepare('SELECT * FROM job_requests WHERE id = ?').get(req.params.id);
  if (!job) { res.status(404).json({ error: 'Job request not found.' }); return null; }
  if (!canAccess(req, job)) { res.status(403).json({ error: 'Not allowed to view this request.' }); return null; }
  return job;
}

// ---- Create a job request (public; attaches to the logged-in customer when present) ----
router.post('/', ah(async (req, res) => {
  // optionalAuth already attached req.user when a valid token was sent.
  const b = req.body || {};
  const errors = {};
  if (!isNonEmpty(b.name, 120)) errors.name = 'Full name is required.';
  if (!isPhone(b.phone)) errors.phone = 'A valid phone is required.';
  if (b.email && !isEmail(b.email)) errors.email = 'Email looks invalid.';
  if (!isNonEmpty(b.address, 200)) errors.address = 'Project address is required.';
  if (!TRADES[b.service_type]) errors.service_type = 'Choose a valid service type.';
  if (b.urgency && !['standard', 'urgent'].includes(b.urgency)) errors.urgency = 'Invalid urgency.';
  if (!isNonEmpty(b.description, 2000)) errors.description = 'Please describe the work.';
  if (failIfErrors(res, errors)) return;

  const claimToken = crypto.randomBytes(16).toString('hex');
  const info = db.prepare(
    `INSERT INTO job_requests (customer_id, name, phone, email, address, city, state, zip,
      service_type, urgency, description, scope_json, claim_token)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    req.user && req.user.role === 'customer' ? req.user.id : null,
    b.name.trim(), b.phone.trim(), (b.email || '').trim().toLowerCase() || null,
    b.address.trim(), (b.city || '').trim(), (b.state || '').trim().toUpperCase(), (b.zip || '').trim(),
    b.service_type, b.urgency || 'standard', b.description.trim(),
    JSON.stringify(b.scope && typeof b.scope === 'object' ? b.scope : {}),
    claimToken
  );
  const job = db.prepare('SELECT * FROM job_requests WHERE id = ?').get(info.lastInsertRowid);
  refreshLeadScore(job.id);
  res.status(201).json({ ...publicJob(db.prepare('SELECT * FROM job_requests WHERE id = ?').get(job.id)), claim_token: claimToken });
}));

// ---- Upload photos for a request (runs the vision hook, optimizes images) ----
router.post('/:id/photos', upload.array('photos', 6), ah(async (req, res) => {
  const job = loadJob(req, res);
  if (!job) return;
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No photos received.' });

  const analyzed = await vision.analyzePhotos(req.files.map(f => ({
    path: f.path, mime: f.mimetype, filename: f.filename, originalName: f.originalname,
  })));

  const saved = [];
  for (const f of req.files) {
    const opt = await photoSvc.optimize(f.path, f.mimetype);
    const info = db.prepare(
      `INSERT INTO photos (job_request_id, filename, original_name, mime, size_bytes, width, height, kind, vision_json, uploaded_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(job.id, f.filename, f.originalname, f.mimetype, opt.size, opt.width, opt.height, 'request',
      JSON.stringify(analyzed), req.user ? req.user.id : null);
    saved.push(db.prepare('SELECT * FROM photos WHERE id = ?').get(info.lastInsertRowid));
  }
  touchInteraction(job.id, 'photos_uploaded', `${saved.length} photo(s)${photoSvc.available() ? ' (optimized)' : ''}`);
  res.status(201).json({ photos: saved, vision: { mode: analyzed.mode, observations: analyzed.observations }, optimized: photoSvc.available() });
}));

// ---- Run the REAL estimation engine on a request ----
router.post('/:id/estimate', ah(async (req, res) => {
  const job = loadJob(req, res);
  if (!job) return;
  const scope = { ...(JSON.parse(job.scope_json || '{}')), ...((req.body && req.body.scope) || {}) };
  if (req.body && req.body.scope) {
    db.prepare('UPDATE job_requests SET scope_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(JSON.stringify(scope), job.id);
  }
  const photoCount = db.prepare('SELECT COUNT(*) c FROM photos WHERE job_request_id = ?').get(job.id).c;

  let result;
  try {
    result = estimateJob({
      service_type: job.service_type, urgency: job.urgency, state: job.state,
      scope, photoCount,
    });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // Merge vision-derived risks from the request photos (stored at upload time).
  const photoRows = db.prepare('SELECT vision_json FROM photos WHERE job_request_id = ?').all(job.id);
  const seen = new Set(result.risks.map(r => r.flag));
  for (const p of photoRows) {
    try {
      const v = JSON.parse(p.vision_json || '{}');
      for (const r of v.risks || []) {
        if (r && r.flag && !seen.has(r.flag)) { seen.add(r.flag); result.risks.push(r); }
      }
      if (v.room_hint && !scope.room_type) result.factors.push(`Vision suggests the room looks like: ${v.room_hint}.`);
    } catch (e) { /* ignore malformed */ }
  }

  const info = db.prepare(
    `INSERT INTO estimates (job_request_id, low_cents, high_cents, line_items_json, missing_json,
      risks_json, confidence, factors_json, engine_version)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(job.id, result.low_cents, result.high_cents,
    JSON.stringify(result.line_items), JSON.stringify(result.missing),
    JSON.stringify(result.risks), result.confidence, JSON.stringify(result.factors), result.engine_version);
  db.prepare(`UPDATE job_requests SET status = 'ai_analyzed', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(job.id);
  touchInteraction(job.id, 'estimate_requested', `engine v${result.engine_version}`);
  res.status(201).json({ id: info.lastInsertRowid, job_request_id: job.id, ...result });
}));

router.get('/:id/estimate/latest', ah(async (req, res) => {
  const job = loadJob(req, res);
  if (!job) return;
  const e = db.prepare('SELECT * FROM estimates WHERE job_request_id = ? ORDER BY id DESC LIMIT 1').get(job.id);
  if (!e) return res.status(404).json({ error: 'No estimate yet for this request.' });
  res.json({
    ...e,
    line_items: JSON.parse(e.line_items_json), missing: JSON.parse(e.missing_json),
    risks: JSON.parse(e.risks_json), factors: JSON.parse(e.factors_json),
  });
}));

// ---- Read one request (with photos + latest estimate summary) ----
router.get('/:id', ah(async (req, res) => {
  const job = loadJob(req, res);
  if (!job) return;
  const photos = db.prepare('SELECT id, filename, original_name, mime, size_bytes, kind, created_at FROM photos WHERE job_request_id = ?').all(job.id);
  const est = db.prepare('SELECT id, low_cents, high_cents, confidence, created_at FROM estimates WHERE job_request_id = ? ORDER BY id DESC LIMIT 1').get(job.id);
  res.json({ ...publicJob(job), photos, latest_estimate: est || null });
}));

// ---- Customer: my requests ----
router.get('/mine/list', authRequired, requireRole('customer'), ah(async (req, res) => {
  const rows = db.prepare('SELECT * FROM job_requests WHERE customer_id = ? ORDER BY id DESC').all(req.user.id);
  res.json(rows.map(publicJob));
}));

// ---- Admin: list / update ----
router.get('/', authRequired, requireRole('admin'), ah(async (req, res) => {
  const { status } = req.query;
  const rows = status
    ? db.prepare('SELECT * FROM job_requests WHERE status = ? ORDER BY id DESC').all(status)
    : db.prepare('SELECT * FROM job_requests ORDER BY id DESC LIMIT 200').all();
  res.json(rows);
}));

router.patch('/:id', authRequired, requireRole('admin'), ah(async (req, res) => {
  const job = db.prepare('SELECT * FROM job_requests WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job request not found.' });
  const allowed = ['new', 'ai_analyzed', 'quote_sent', 'deposit_paid', 'assigned', 'scheduled', 'in_progress', 'review', 'completed', 'lost', 'cancelled'];
  const { status } = req.body || {};
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  db.prepare('UPDATE job_requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, job.id);
  res.json(db.prepare('SELECT * FROM job_requests WHERE id = ?').get(job.id));
}));

module.exports = router;
