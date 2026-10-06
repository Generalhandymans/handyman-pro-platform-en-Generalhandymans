// Projects: execution flow with milestones, client approvals, tracking, photos.
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { ah, authRequired, requireRole, isNonEmpty, failIfErrors } = require('../middleware');
const { notify, shell } = require('../services/notify');
const { auditLog } = require('../services/audit');
const { touchInteraction } = require('../services/crm');
const photoSvc = require('../services/photos');

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
async function projectVisibleTo(req, p) {
  if (req.user.role === 'admin') return true;
  if (req.user.role === 'contractor') {
    const c = await db.prepare('SELECT id FROM contractors WHERE user_id = ?').get(req.user.id);
    return c && p.contractor_id === c.id;
  }
  const job = await db.prepare('SELECT customer_id FROM job_requests WHERE id = ?').get(p.job_request_id);
  return job && job.customer_id === req.user.id;
}

async function withDetails(p) {
  return {
    ...p,
    milestones: await db.prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY sort_order').all(p.id),
    photos: await db.prepare('SELECT id, filename, original_name, mime, kind, created_at FROM photos WHERE project_id = ? ORDER BY id').all(p.id),
    payments: await db.prepare('SELECT * FROM payments WHERE project_id = ? ORDER BY id').all(p.id),
    contractor: p.contractor_id
      ? await db.prepare('SELECT c.*, u.name, u.email FROM contractors c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(p.contractor_id)
      : null,
  };
}

async function loadProject(req, res) {
  const p = await db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!p) { res.status(404).json({ error: 'Project not found.' }); return null; }
  if (!await projectVisibleTo(req, p)) { res.status(403).json({ error: 'Not allowed.' }); return null; }
  return p;
}

router.get('/', authRequired, ah(async (req, res) => {
  let rows;
  if (req.user.role === 'admin') {
    rows = await db.prepare('SELECT * FROM projects ORDER BY id DESC LIMIT 200').all();
  } else if (req.user.role === 'contractor') {
    const c = await db.prepare('SELECT id FROM contractors WHERE user_id = ?').get(req.user.id);
    rows = c ? await db.prepare('SELECT * FROM projects WHERE contractor_id = ? ORDER BY id DESC').all(c.id) : [];
  } else {
    rows = await db.prepare(
      `SELECT p.* FROM projects p JOIN job_requests j ON j.id = p.job_request_id
       WHERE j.customer_id = ? ORDER BY p.id DESC`
    ).all(req.user.id);
  }
  res.json(rows.map(withDetails));
}));

router.get('/:id', authRequired, ah(async (req, res) => {
  const p = await loadProject(req, res);
  if (!p) return;
  res.json(await withDetails(p));
}));

// ---- Admin: contractor recommendations for a project (matching engine) ----
router.get('/:id/recommendations', authRequired, requireRole('admin'), ah(async (req, res) => {
  const p = await db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  const job = await db.prepare('SELECT service_type FROM job_requests WHERE id = ?').get(p.job_request_id);
  const contractors = await db.prepare(
    `SELECT c.*, u.name AS user_name FROM contractors c
     JOIN users u ON u.id = c.user_id WHERE c.status = 'active'`
  ).all();
  const { rankContractors, matchContractor } = require('../services/matching');
  const projectInput = {
    id: p.id,
    service_type: job ? job.service_type : null,
    customer_price_cents: p.customer_price_cents,
    contractor_cost_cents: p.contractor_cost_cents,
  };
  const adapted = contractors.map(c => ({
    ...c,
    distance_miles: null, // no geodata in current schema yet
    license_verified: !!c.license_verified,
    insurance_verified: !!c.insurance_verified,
    current_workload: 0,
  }));
  const ranked = rankContractors(projectInput, adapted).slice(0, 10);
  const ineligible = adapted
    .map(c => ({ contractor: c, match: matchContractor(projectInput, c) }))
    .filter(x => !x.match.eligible)
    .map(({ contractor, match }) => ({
      contractor_id: contractor.id,
      contractor_name: contractor.legal_name || contractor.user_name,
      reason: match.reason,
    }));
  res.json({
    recommendations: ranked.map(({ contractor, match }) => ({
      contractor_id: contractor.id,
      contractor_name: contractor.legal_name || contractor.user_name,
      city: contractor.city,
      rating_avg: contractor.rating_avg,
      score: match.score,
      parts: match.parts,
      strongest: match.explanation.strongest,
      weakest: match.explanation.weakest,
    })),
    meta: { eligible: ranked.length, active_total: contractors.length, ineligible },
  });
}));

// ---- Admin: offer a project to a contractor (contractor must accept + agree to terms) ----
router.post('/:id/assign', authRequired, requireRole('admin'), ah(async (req, res) => {
  const p = await db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  const c = await db.prepare('SELECT * FROM contractors WHERE id = ?').get((req.body || {}).contractor_id);
  if (!c) return res.status(400).json({ error: 'Contractor not found.' });
  if (c.status !== 'active') return res.status(400).json({ error: 'Contractor is not active.' });
  await db.prepare(`UPDATE projects SET contractor_id = ?, contractor_status = 'offered', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(c.id, p.id);
  auditLog(req.user.id, 'project.contractor_offered', 'projects', p.id, `Project offered to contractor #${c.id}`);

  // Notify the contractor: review the offer and accept it from their portal.
  const cu = await db.prepare('SELECT name, email FROM users WHERE id = ?').get(c.user_id);
  const job = await db.prepare('SELECT * FROM job_requests WHERE id = ?').get(p.job_request_id);
  if (cu && cu.email) {
    await notify({
      to: cu.email,
      subject: `New job offer — ${job.service_type} (#${p.id})`,
      html: shell('You have a new job offer', `Hi ${cu.name.split(' ')[0]}, Helpman is offering you a project. Review the details and accept it from your portal — accepting means you agree to the Independent Contractor Terms:`, [
        ['Project', `#${p.id} — ${job.service_type}`],
        ['Address', job.address],
        ['Your budget', '$' + (p.contractor_cost_cents / 100).toFixed(2)],
        ['Customer notes', (job.description || '').slice(0, 200)],
      ]),
    }).catch(() => {});
  }
  res.json(await db.prepare('SELECT * FROM projects WHERE id = ?').get(p.id));
}));

// ---- Contractor: accept or decline an offered project (accept requires terms) ----
router.post('/:id/contractor-respond', authRequired, ah(async (req, res) => {
  const p = await db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  if (!['contractor', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Not allowed.' });
  }
  if (req.user.role === 'contractor') {
    const c = await db.prepare('SELECT id FROM contractors WHERE user_id = ?').get(req.user.id);
    if (!c || p.contractor_id !== c.id) {
      return res.status(403).json({ error: 'This project was not offered to you.' });
    }
  }
  if (p.contractor_status !== 'offered') {
    return res.status(400).json({ error: 'This project is not awaiting your response.' });
  }
  const accept = (req.body || {}).accept === true;
  const termsAccepted = (req.body || {}).terms_accepted === true;

  if (!accept) {
    await db.prepare(`UPDATE projects SET contractor_id = NULL, contractor_status = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(p.id);
    auditLog(req.user.id, 'project.contractor_declined', 'projects', p.id, 'Contractor declined the offer');
    const admins = await db.prepare("SELECT email FROM users WHERE role = 'admin'").all();
    const job = await db.prepare('SELECT * FROM job_requests WHERE id = ?').get(p.job_request_id);
    for (const a of admins) {
      await notify({
        to: a.email,
        subject: `Contractor declined project #${p.id}`,
        html: shell('Offer declined', 'The contractor declined the job offer. Please assign another professional:', [
          ['Project', `#${p.id} — ${job.service_type}`],
        ]),
      }).catch(() => {});
    }
    touchInteraction(p.job_request_id, 'contractor_reply', 'offer declined');
    return res.json({ accepted: false });
  }

  // Legal gate: accepting the job requires explicit acceptance of the
  // Independent Contractor Terms.
  if (!termsAccepted) {
    return res.status(400).json({ error: 'You must accept the Independent Contractor Terms to take this job.' });
  }
  const { CONTRACTOR_TERMS_VERSION, recordAcceptance } = require('../services/terms');
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || null;

  await db.prepare(`UPDATE projects SET contractor_status = 'accepted', stage = 'scheduled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(p.id);
  await db.prepare(`UPDATE job_requests SET status = 'assigned', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(p.job_request_id);
  recordAcceptance({ userId: req.user.id, kind: 'contractor_job', referenceId: p.id, version: CONTRACTOR_TERMS_VERSION, ip });
  auditLog(req.user.id, 'project.contractor_accepted', 'projects', p.id, `Contractor accepted under terms v${CONTRACTOR_TERMS_VERSION}`);
  touchInteraction(p.job_request_id, 'contractor_reply', 'offer accepted');

  // Notify the customer that a pro accepted and the job is scheduled.
  const job = await db.prepare('SELECT * FROM job_requests WHERE id = ?').get(p.job_request_id);
  const custEmail = job.customer_id
    ? (await db.prepare('SELECT email FROM users WHERE id = ?').get(job.customer_id) || {}).email
    : job.email;
  const pro = await db.prepare('SELECT u.name FROM contractors c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(p.contractor_id);
  if (custEmail) {
    await notify({
      to: custEmail,
      subject: `A professional accepted your project (#${p.id})`,
      html: shell('Professional confirmed', 'Good news — a verified professional accepted your project and it is now scheduled:', [
        ['Project', `#${p.id} — ${job.service_type}`],
        ['Professional', pro ? pro.name : 'Assigned pro'],
      ]),
    }).catch(() => {});
  }
  res.json({ accepted: true, project: await db.prepare('SELECT * FROM projects WHERE id = ?').get(p.id) });
}));

// ---- Admin: set scheduled dates (end must be >= start) ----
router.patch('/:id/schedule', authRequired, requireRole('admin'), ah(async (req, res) => {
  const p = await db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  const { scheduled_start, scheduled_end } = req.body || {};
  const errors = {};
  const parse = (v, field) => {
    if (v === null || v === undefined || v === '') return null;
    const d = new Date(v);
    if (isNaN(d.getTime())) { errors[field] = 'Invalid date.'; return null; }
    return d.toISOString().slice(0, 10);
  };
  const start = parse(scheduled_start, 'scheduled_start');
  const end = parse(scheduled_end, 'scheduled_end');
  if (!errors.scheduled_start && !errors.scheduled_end && start && end && end < start) {
    errors.scheduled_end = 'End date cannot be before the start date.';
  }
  if (failIfErrors(res, errors)) return;
  await db.prepare(`UPDATE projects SET scheduled_start = ?, scheduled_end = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(start, end, p.id);
  auditLog(req.user.id, 'project.scheduled', 'projects', p.id, `Scheduled ${start || '—'} → ${end || '—'}`);
  res.json(await db.prepare('SELECT * FROM projects WHERE id = ?').get(p.id));
}));

// ---- Move stage (admin, or assigned contractor for execution stages) ----
router.patch('/:id/stage', authRequired, ah(async (req, res) => {
  const p = await loadProject(req, res);
  if (!p) return;
  const { stage } = req.body || {};
  if (!STAGES.includes(stage)) return res.status(400).json({ error: 'Invalid stage.' });
  if (req.user.role === 'contractor' && !['scheduled', 'in_progress', 'review'].includes(stage)) {
    return res.status(403).json({ error: 'Contractors can only move scheduled/in_progress/review.' });
  }
  if (req.user.role === 'contractor' && p.contractor_status !== 'accepted') {
    return res.status(403).json({ error: 'Accept the job offer first.' });
  }
  if (req.user.role === 'customer') return res.status(403).json({ error: 'Customers cannot move stages.' });

  await db.prepare(`UPDATE projects SET stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(stage, p.id);
  const jobStatus = { scheduled: 'scheduled', in_progress: 'in_progress', review: 'review', completed: 'completed', cancelled: 'cancelled' }[stage];
  if (jobStatus) await db.prepare(`UPDATE job_requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(jobStatus, p.job_request_id);

  if (stage === 'completed') {
    // Close the loop: contractor stats + job completion.
    if (p.contractor_id) {
      await db.prepare('UPDATE contractors SET jobs_completed = jobs_completed + 1 WHERE id = ?').run(p.contractor_id);
    }
    // Notify the customer that the project is complete.
    const job = await db.prepare('SELECT * FROM job_requests WHERE id = ?').get(p.job_request_id);
    const custEmail = job.customer_id
      ? (await db.prepare('SELECT email FROM users WHERE id = ?').get(job.customer_id) || {}).email
      : job.email;
    if (custEmail) {
      await notify({
        to: custEmail,
        subject: `Your project is complete (#${p.id}) 🎉`,
        html: shell('Project completed', 'Your project is complete. Please leave a review from your portal:', [
          ['Project', `#${p.id} — ${job.service_type}`],
          ['Address', job.address],
        ]),
      }).catch(() => {});
    }
  }
  auditLog(req.user.id, 'project.stage', 'projects', p.id, `Stage → ${stage}`);
  res.json(await db.prepare('SELECT * FROM projects WHERE id = ?').get(p.id));
}));

// ---- Contractor/admin: mark a milestone done ----
router.post('/:id/milestones/:mid/complete', authRequired, ah(async (req, res) => {
  const p = await loadProject(req, res);
  if (!p) return;
  if (!['admin', 'contractor'].includes(req.user.role)) return res.status(403).json({ error: 'Not allowed.' });
  const m = await db.prepare('SELECT * FROM milestones WHERE id = ? AND project_id = ?').get(req.params.mid, p.id);
  if (!m) return res.status(404).json({ error: 'Milestone not found.' });
  await db.prepare(`UPDATE milestones SET status = 'completed' WHERE id = ?`).run(m.id);
  auditLog(req.user.id, 'milestone.completed', 'milestones', m.id, `Project #${p.id}: "${m.title}"`);

  // Notify the customer to review/approve.
  const job = await db.prepare('SELECT * FROM job_requests WHERE id = ?').get(p.job_request_id);
  const custEmail = job.customer_id
    ? (await db.prepare('SELECT email FROM users WHERE id = ?').get(job.customer_id) || {}).email
    : job.email;
  if (custEmail) {
    await notify({
      to: custEmail,
      subject: `Milestone done — please review: ${m.title}`,
      html: shell('A milestone is ready for your review', `${req.user.name} marked a milestone as complete:`, [
        ['Project', `#${p.id} — ${job.service_type}`],
        ['Milestone', m.title],
      ]),
    }).catch(() => {});
  }
  res.json(await db.prepare('SELECT * FROM milestones WHERE id = ?').get(m.id));
}));

// ---- Customer: approve / reject a completed milestone ----
router.post('/:id/milestones/:mid/approve', authRequired, ah(async (req, res) => {
  const p = await loadProject(req, res);
  if (!p) return;
  const job = await db.prepare('SELECT customer_id FROM job_requests WHERE id = ?').get(p.job_request_id);
  const isOwner = job.customer_id === req.user.id;
  if (req.user.role !== 'admin' && !isOwner) return res.status(403).json({ error: 'Only the customer can approve.' });
  const m = await db.prepare('SELECT * FROM milestones WHERE id = ? AND project_id = ?').get(req.params.mid, p.id);
  if (!m) return res.status(404).json({ error: 'Milestone not found.' });
  const approved = (req.body || {}).approved !== false;
  await db.prepare(`UPDATE milestones SET customer_approval = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(approved ? 'approved' : 'rejected', m.id);
  auditLog(req.user.id, approved ? 'milestone.approved' : 'milestone.rejected', 'milestones', m.id,
    `Project #${p.id}: "${m.title}"`);

  // Notify the contractor of the customer's decision.
  if (p.contractor_id) {
    const cu = await db.prepare('SELECT u.email, u.name FROM contractors c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(p.contractor_id);
    if (cu && cu.email) {
      await notify({
        to: cu.email,
        subject: approved ? `Milestone approved: ${m.title}` : `Milestone needs rework: ${m.title}`,
        html: shell(approved ? 'Milestone approved ✓' : 'Milestone sent back', `The customer ${approved ? 'approved' : 'asked for rework on'}:`, [
          ['Project', `#${p.id}`],
          ['Milestone', m.title],
        ]),
      }).catch(() => {});
    }
  }
  res.json(await db.prepare('SELECT * FROM milestones WHERE id = ?').get(m.id));
}));

// ---- Progress / completion photos (contractor or admin) ----
router.post('/:id/photos', authRequired, upload.array('photos', 6), ah(async (req, res) => {
  const p = await loadProject(req, res);
  if (!p) return;
  if (!['admin', 'contractor'].includes(req.user.role)) return res.status(403).json({ error: 'Not allowed.' });
  const kind = ['progress', 'completion'].includes((req.body || {}).kind) ? req.body.kind : 'progress';
  const saved = [];
  for (const f of req.files || []) {
    const opt = await photoSvc.optimize(f.path, f.mimetype);
    const info = await db.prepare(
      `INSERT INTO photos (project_id, filename, original_name, mime, size_bytes, width, height, kind, uploaded_by)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(p.id, f.filename, f.originalname, f.mimetype, opt.size, opt.width, opt.height, kind, req.user.id);
    saved.push({ ...await db.prepare('SELECT id, original_name, mime, kind, created_at FROM photos WHERE id = ?').get(info.lastInsertRowid), optimized: opt.optimized });
  }
  res.status(201).json({ photos: saved });
}));

module.exports = router;
