// Projects: execution flow with milestones, client approvals, tracking, photos.
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { ah, authRequired, requireRole, failIfErrors } = require('../middleware');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 5 * 1024 * 1024, files: 6 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed (max 5 MB each).'));
  },
});

const STAGES = ['assigned', 'scheduled', 'in_progress', 'review', 'completed', 'cancelled'];

// Visibility: admin sees all; contractor sees assigned-to-me; customer sees own jobs' projects.
function projectVisibleTo(req, p) {
  if (req.user.role === 'admin') return true;
  if (req.user.role === 'contractor') {
    const c = db.prepare('SELECT id FROM contractors WHERE user_id = ?').get(req.user.id);
    return c && p.contractor_id === c.id;
  }
  const job = db.prepare('SELECT customer_id FROM job_requests WHERE id = ?').get(p.job_request_id);
  return job && job.customer_id === req.user.id;
}

function withDetails(p) {
  return {
    ...p,
    milestones: db.prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY sort_order').all(p.id),
    photos: db.prepare('SELECT id, filename, original_name, mime, kind, created_at FROM photos WHERE project_id = ? ORDER BY id').all(p.id),
    payments: db.prepare('SELECT * FROM payments WHERE project_id = ? ORDER BY id').all(p.id),
    contractor: p.contractor_id
      ? db.prepare('SELECT c.*, u.name, u.email FROM contractors c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(p.contractor_id)
      : null,
  };
}

function loadProject(req, res) {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!p) { res.status(404).json({ error: 'Project not found.' }); return null; }
  if (!projectVisibleTo(req, p)) { res.status(403).json({ error: 'Not allowed.' }); return null; }
  return p;
}

router.get('/', authRequired, ah(async (req, res) => {
  let rows;
  if (req.user.role === 'admin') {
    rows = db.prepare('SELECT * FROM projects ORDER BY id DESC LIMIT 200').all();
  } else if (req.user.role === 'contractor') {
    const c = db.prepare('SELECT id FROM contractors WHERE user_id = ?').get(req.user.id);
    rows = c ? db.prepare('SELECT * FROM projects WHERE contractor_id = ? ORDER BY id DESC').all(c.id) : [];
  } else {
    rows = db.prepare(
      `SELECT p.* FROM projects p JOIN job_requests j ON j.id = p.job_request_id
       WHERE j.customer_id = ? ORDER BY p.id DESC`
    ).all(req.user.id);
  }
  res.json(rows.map(withDetails));
}));

router.get('/:id', authRequired, ah(async (req, res) => {
  const p = loadProject(req, res);
  if (!p) return;
  res.json(withDetails(p));
}));

// ---- Admin: assign a contractor ----
router.post('/:id/assign', authRequired, requireRole('admin'), ah(async (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  const c = db.prepare('SELECT * FROM contractors WHERE id = ?').get((req.body || {}).contractor_id);
  if (!c) return res.status(400).json({ error: 'Contractor not found.' });
  if (c.status !== 'active') return res.status(400).json({ error: 'Contractor is not active.' });
  db.prepare(`UPDATE projects SET contractor_id = ?, stage = 'scheduled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(c.id, p.id);
  db.prepare(`UPDATE job_requests SET status = 'assigned', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(p.job_request_id);
  res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(p.id));
}));

// ---- Move stage (admin, or assigned contractor for execution stages) ----
router.patch('/:id/stage', authRequired, ah(async (req, res) => {
  const p = loadProject(req, res);
  if (!p) return;
  const { stage } = req.body || {};
  if (!STAGES.includes(stage)) return res.status(400).json({ error: 'Invalid stage.' });
  if (req.user.role === 'contractor' && !['scheduled', 'in_progress', 'review'].includes(stage)) {
    return res.status(403).json({ error: 'Contractors can only move scheduled/in_progress/review.' });
  }
  if (req.user.role === 'customer') return res.status(403).json({ error: 'Customers cannot move stages.' });

  db.prepare(`UPDATE projects SET stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(stage, p.id);
  const jobStatus = { scheduled: 'scheduled', in_progress: 'in_progress', review: 'review', completed: 'completed', cancelled: 'cancelled' }[stage];
  if (jobStatus) db.prepare(`UPDATE job_requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(jobStatus, p.job_request_id);

  if (stage === 'completed') {
    // Close the loop: contractor stats + job completion.
    if (p.contractor_id) {
      db.prepare('UPDATE contractors SET jobs_completed = jobs_completed + 1 WHERE id = ?').run(p.contractor_id);
    }
  }
  res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(p.id));
}));

// ---- Contractor/admin: mark a milestone done ----
router.post('/:id/milestones/:mid/complete', authRequired, ah(async (req, res) => {
  const p = loadProject(req, res);
  if (!p) return;
  if (!['admin', 'contractor'].includes(req.user.role)) return res.status(403).json({ error: 'Not allowed.' });
  const m = db.prepare('SELECT * FROM milestones WHERE id = ? AND project_id = ?').get(req.params.mid, p.id);
  if (!m) return res.status(404).json({ error: 'Milestone not found.' });
  db.prepare(`UPDATE milestones SET status = 'completed' WHERE id = ?`).run(m.id);
  res.json(db.prepare('SELECT * FROM milestones WHERE id = ?').get(m.id));
}));

// ---- Customer: approve / reject a completed milestone ----
router.post('/:id/milestones/:mid/approve', authRequired, ah(async (req, res) => {
  const p = loadProject(req, res);
  if (!p) return;
  const job = db.prepare('SELECT customer_id FROM job_requests WHERE id = ?').get(p.job_request_id);
  const isOwner = job.customer_id === req.user.id;
  if (req.user.role !== 'admin' && !isOwner) return res.status(403).json({ error: 'Only the customer can approve.' });
  const m = db.prepare('SELECT * FROM milestones WHERE id = ? AND project_id = ?').get(req.params.mid, p.id);
  if (!m) return res.status(404).json({ error: 'Milestone not found.' });
  const approved = (req.body || {}).approved !== false;
  db.prepare(`UPDATE milestones SET customer_approval = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(approved ? 'approved' : 'rejected', m.id);
  res.json(db.prepare('SELECT * FROM milestones WHERE id = ?').get(m.id));
}));

// ---- Progress / completion photos (contractor or admin) ----
router.post('/:id/photos', authRequired, upload.array('photos', 6), ah(async (req, res) => {
  const p = loadProject(req, res);
  if (!p) return;
  if (!['admin', 'contractor'].includes(req.user.role)) return res.status(403).json({ error: 'Not allowed.' });
  const kind = ['progress', 'completion'].includes((req.body || {}).kind) ? req.body.kind : 'progress';
  const saved = [];
  for (const f of req.files || []) {
    const info = db.prepare(
      `INSERT INTO photos (project_id, filename, original_name, mime, size_bytes, kind, uploaded_by)
       VALUES (?,?,?,?,?,?,?)`
    ).run(p.id, f.filename, f.originalname, f.mimetype, f.size, kind, req.user.id);
    saved.push(db.prepare('SELECT id, original_name, mime, kind, created_at FROM photos WHERE id = ?').get(info.lastInsertRowid));
  }
  res.status(201).json({ photos: saved });
}));

module.exports = router;
