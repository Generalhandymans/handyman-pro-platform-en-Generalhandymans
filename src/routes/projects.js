// Projects: execution flow with milestones, client approvals, tracking, photos.
const express = require('express');
const { requireStaff, can } = require('../services/permissions');
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

// Role-aware serializer. The API itself must never hand out what the UI hides:
//  - customers must not see the contractor's cost (= the platform margin) nor
//    any way to contact the contractor directly;
//  - contractors must not see what the customer pays.
async function withDetails(p, role, user) {
  const full = {
    ...p,
    milestones: await db.prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY sort_order').all(p.id),
    photos: await db.prepare('SELECT id, filename, original_name, mime, kind, created_at FROM photos WHERE project_id = ? ORDER BY id').all(p.id),
    payments: await db.prepare('SELECT * FROM payments WHERE project_id = ? ORDER BY id').all(p.id),
    completion_signed_at: ((await db.prepare('SELECT signed_at FROM completion_sheets WHERE project_id = ?').get(p.id)) || {}).signed_at || null,
    contractor: p.contractor_id
      ? await db.prepare('SELECT c.*, u.name, u.email FROM contractors c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(p.contractor_id)
      : null,
  };
  if (role === 'admin') {
    if (user && !can(user, 'costs')) { const { contractor_cost_cents, ...rest } = full; return rest; }
    return full;
  }
  if (role === 'customer') {
    const { contractor_cost_cents, ...proj } = full;
    const c = full.contractor;
    proj.contractor = c ? {
      first_name: String(c.name || '').split(' ')[0],
      rating_avg: c.rating_avg,
      jobs_completed: c.jobs_completed,
      license_verified: !!c.license_verified,
      insurance_verified: !!c.insurance_verified,
    } : null;
    return proj;
  }
  // contractor: keeps their own budget (contractor_cost_cents), loses price + payments.
  const { customer_price_cents, payments, contractor, ...proj } = full;
  return proj;
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
  res.json(await Promise.all(rows.map(r => withDetails(r, req.user.role, req.user))));
}));

// ---- Admin: agenda for a date window (default: today + 6 days) ----
// Active projects with their dates, overlap warnings per contractor, and the
// list that still needs a date. MUST stay above '/:id'.
router.get('/schedule', authRequired, requireStaff('read'), ah(async (req, res) => {
  const sched = require('../services/schedule');
  const from = sched.DATE_RE.test(String(req.query.from || '')) ? req.query.from : new Date().toISOString().slice(0, 10);
  const to = sched.DATE_RE.test(String(req.query.to || '')) ? req.query.to : sched.addDays(from, 6);
  if (to < from) return res.status(422).json({ error: 'Validation failed', fields: { to: 'End date cannot be before the start date.' } });
  const rows = await db.prepare(
    `SELECT p.id, p.stage, p.contractor_id, p.contractor_status, p.scheduled_start, p.scheduled_end,
            j.service_type, j.address, j.city, j.name AS customer_name, j.urgency,
            COALESCE(c.legal_name, u.name) AS contractor_name
     FROM projects p
     JOIN job_requests j ON j.id = p.job_request_id
     LEFT JOIN contractors c ON c.id = p.contractor_id
     LEFT JOIN users u ON u.id = c.user_id
     WHERE p.stage IN ('assigned','scheduled','in_progress','review')
     ORDER BY p.id DESC LIMIT 500`
  ).all();
  res.json(sched.buildSchedule(rows, from, to));
}));

router.get('/:id', authRequired, ah(async (req, res) => {
  const p = await loadProject(req, res);
  if (!p) return;
  res.json(await withDetails(p, req.user.role, req.user));
}));

// ---- Admin: contractor recommendations for a project (matching engine) ----
router.get('/:id/recommendations', authRequired, requireStaff('dispatch'), ah(async (req, res) => {
  const p = await db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  const job = await db.prepare('SELECT service_type, lat, lng FROM job_requests WHERE id = ?').get(p.job_request_id);
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
  const load = await db.prepare(
    `SELECT contractor_id, COUNT(*) AS n FROM projects
     WHERE contractor_id IS NOT NULL AND stage IN ('assigned','scheduled','in_progress','review')
     GROUP BY contractor_id`
  ).all();
  const workloadBy = Object.fromEntries(load.map(r => [r.contractor_id, Number(r.n)]));
  const geo = require('../services/geocode');
  const adapted = contractors.map(c => ({
    ...c,
    // null (neutral score) until both the job and the contractor have coordinates
    distance_miles: geo.miles(job, c),
    license_verified: !!c.license_verified,
    insurance_verified: !!c.insurance_verified,
    current_workload: workloadBy[c.id] || 0,
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
router.post('/:id/assign', authRequired, requireStaff('dispatch'), ah(async (req, res) => {
  const p = await db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  const c = await db.prepare('SELECT * FROM contractors WHERE id = ?').get((req.body || {}).contractor_id);
  if (!c) return res.status(400).json({ error: 'Contractor not found.' });
  if (c.status !== 'active') return res.status(400).json({ error: 'Contractor is not active.' });
  // Gate: no contractor is offered a job until the deposit is in.
  const jobRow = await db.prepare('SELECT status FROM job_requests WHERE id = ?').get(p.job_request_id);
  if (!jobRow || !['deposit_paid', 'assigned', 'scheduled', 'in_progress', 'review'].includes(jobRow.status)) {
    return res.status(409).json({ error: 'The deposit has not been paid yet. Offer the job after the deposit is recorded.' });
  }
  await db.prepare(`UPDATE projects SET contractor_id = ?, contractor_status = 'offered', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(c.id, p.id);
  await auditLog(req.user.id, 'project.contractor_offered', 'projects', p.id, `Project offered to contractor #${c.id}`);

  // Notify the contractor: review the offer and accept it from their portal.
  const cu = await db.prepare('SELECT name, email FROM users WHERE id = ?').get(c.user_id);
  const job = await db.prepare('SELECT * FROM job_requests WHERE id = ?').get(p.job_request_id);
  if (cu && cu.email) {
    await notify({
      to: cu.email,
      subject: `New job offer — ${job.service_type} (#${p.id})`,
      html: shell('You have a new job offer', `Hi ${cu.name.split(' ')[0]}, General Handyman Solutions is offering you a project. Review the details and accept it from your portal — accepting means you agree to the Independent Contractor Terms:`, [
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
    await auditLog(req.user.id, 'project.contractor_declined', 'projects', p.id, 'Contractor declined the offer');
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
    await touchInteraction(p.job_request_id, 'contractor_reply', 'offer declined');
    return res.json({ accepted: false });
  }

  // Legal gate: accepting the job requires explicit acceptance of the
  // Independent Contractor Terms.
  if (!termsAccepted) {
    return res.status(400).json({ error: 'You must accept the Independent Contractor Terms to take this job.' });
  }
  const { CONTRACTOR_TERMS_VERSION, recordAcceptance } = require('../services/terms');
  const ip = req.ip || null;

  await db.prepare(`UPDATE projects SET contractor_status = 'accepted', stage = 'scheduled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(p.id);
  await db.prepare(`UPDATE job_requests SET status = 'assigned', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(p.job_request_id);
  await recordAcceptance({ userId: req.user.id, kind: 'contractor_job', referenceId: p.id, version: CONTRACTOR_TERMS_VERSION, ip });
  await auditLog(req.user.id, 'project.contractor_accepted', 'projects', p.id, `Contractor accepted under terms v${CONTRACTOR_TERMS_VERSION}`);
  await touchInteraction(p.job_request_id, 'contractor_reply', 'offer accepted');

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
router.patch('/:id/schedule', authRequired, requireStaff('dispatch'), ah(async (req, res) => {
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
  await auditLog(req.user.id, 'project.scheduled', 'projects', p.id, `Scheduled ${start || '—'} → ${end || '—'}`);
  const updated = await db.prepare('SELECT * FROM projects WHERE id = ?').get(p.id);
  // Warn (never block) when the same contractor is already booked on those dates.
  let conflicts = [];
  if (updated.contractor_id != null && updated.scheduled_start) {
    const sched = require('../services/schedule');
    const others = await db.prepare(
      'SELECT id, stage, contractor_id, scheduled_start, scheduled_end FROM projects WHERE contractor_id = ?'
    ).all(updated.contractor_id);
    conflicts = sched.conflictsFor(updated, others);
  }
  res.json({ ...updated, conflicts });
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
  if (req.user.role === 'admin' && !can(req.user, 'dispatch')) return res.status(403).json({ error: 'Your team role cannot move project stages.', code: 'STAFF_ROLE' });

  // Gate: a project closes only after the customer approved every milestone
  // (an admin may override with force:true — that override is audited).
  if (stage === 'completed') {
    const ms = await db.prepare('SELECT customer_approval FROM milestones WHERE project_id = ?').all(p.id);
    const allApproved = ms.length > 0 && ms.every(m => m.customer_approval === 'approved');
    if (!allApproved) {
      if (req.user.role === 'admin' && (req.body || {}).force === true) {
        await auditLog(req.user.id, 'project.force_completed', 'projects', p.id, 'Completed without all milestones approved');
      } else {
        return res.status(409).json({ error: 'Every milestone must be approved by the customer before the project can be completed.' });
      }
    }
  }

  await db.prepare(`UPDATE projects SET stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(stage, p.id);
  const jobStatus = { scheduled: 'scheduled', in_progress: 'in_progress', review: 'review', completed: 'completed', cancelled: 'cancelled' }[stage];
  if (jobStatus) await db.prepare(`UPDATE job_requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(jobStatus, p.job_request_id);

  // Only on the TRANSITION into completed: re-sending the same stage must not
  // count the job twice or email the customer again.
  if (stage === 'completed' && p.stage !== 'completed') {
    // Close the loop: contractor stats + job completion.
    if (p.contractor_id) {
      await db.prepare('UPDATE contractors SET jobs_completed = jobs_completed + 1 WHERE id = ?').run(p.contractor_id);
      // What we owe the contractor for this job (admin approves and pays it later).
      await require('../services/payables').ensurePayable(p);
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
  await auditLog(req.user.id, 'project.stage', 'projects', p.id, `Stage → ${stage}`);
  res.json(await db.prepare('SELECT * FROM projects WHERE id = ?').get(p.id));
}));

// ---- Completion sheet: the customer signs off on the finished work ----
// Opens when EVERY milestone is approved. Signing is the customer's formal
// acceptance and unlocks the final payment. Stores who, when, from which IP,
// the checklist they confirmed and a drawn signature (PNG).
router.get('/:id/sign-off', authRequired, ah(async (req, res) => {
  const p = await loadProject(req, res);
  if (!p) return;
  const sheet = await db.prepare('SELECT * FROM completion_sheets WHERE project_id = ?').get(p.id);
  if (!sheet) return res.json({ signed: false });
  if (req.user.role === 'contractor') return res.json({ signed: true, signed_at: sheet.signed_at });
  const { signer_user_id, ip, ...rest } = sheet;
  res.json({ signed: true, ...rest, checklist: JSON.parse(sheet.checklist_json || '{}'), ...(req.user.role === 'admin' ? { ip, signer_user_id } : {}) });
}));

router.post('/:id/sign-off', authRequired, ah(async (req, res) => {
  const p = await loadProject(req, res);
  if (!p) return;
  if (req.user.role !== 'customer') return res.status(403).json({ error: 'Only the customer can sign off on the work.' });
  if (!['in_progress', 'review', 'completed'].includes(p.stage)) {
    return res.status(409).json({ error: 'The work is not ready for sign-off yet.' });
  }
  const ms = await db.prepare('SELECT customer_approval FROM milestones WHERE project_id = ?').all(p.id);
  if (!ms.length || ms.some(m => m.customer_approval !== 'approved')) {
    return res.status(409).json({ error: 'Approve every milestone before signing off.' });
  }
  if (await db.prepare('SELECT id FROM completion_sheets WHERE project_id = ?').get(p.id)) {
    return res.status(409).json({ error: 'This project is already signed off.' });
  }
  const b = req.body || {};
  const errors = {};
  if (!isNonEmpty(b.signer_name, 120)) errors.signer_name = 'Type your full name.';
  const sig = typeof b.signature === 'string' ? b.signature : '';
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sig) || sig.length < 800) errors.signature = 'Please draw your signature.';
  else if (sig.length > 300000) errors.signature = 'Signature image is too large.';
  const cl = b.checklist && typeof b.checklist === 'object' ? b.checklist : {};
  if (cl.work_complete !== true) errors.work_complete = 'Confirm the work is complete.';
  if (cl.site_clean !== true) errors.site_clean = 'Confirm the work area is clean.';
  if (b.notes && !isNonEmpty(b.notes, 1000)) errors.notes = 'Notes are too long.';
  if (failIfErrors(res, errors)) return;

  try {
    await db.prepare(
      `INSERT INTO completion_sheets (project_id, signer_user_id, signer_name, signature_png, checklist_json, notes, ip)
       VALUES (?,?,?,?,?,?,?)`
    ).run(p.id, req.user.id, b.signer_name.trim(), sig,
      JSON.stringify({ work_complete: true, site_clean: true }), (b.notes || '').trim() || null, req.ip || null);
  } catch (e) {
    // UNIQUE(project_id): a simultaneous second signature loses cleanly.
    return res.status(409).json({ error: 'This project is already signed off.' });
  }
  await auditLog(req.user.id, 'project.signed_off', 'projects', p.id, `Signed by ${b.signer_name.trim()}`);
  const job = await db.prepare('SELECT service_type, name FROM job_requests WHERE id = ?').get(p.job_request_id);
  const admins = await db.prepare("SELECT email FROM users WHERE role = 'admin'").all();
  for (const a of admins) {
    await notify({
      to: a.email,
      subject: `Customer signed off — project #${p.id}`,
      html: shell('Completion sheet signed', `${job ? job.name : 'The customer'} signed off on the finished work. The final payment is now open to them.`, [
        ['Project', `#${p.id} — ${job ? job.service_type : ''}`],
        ['Signed by', b.signer_name.trim()],
      ]),
    }).catch(() => {});
  }
  const sheet = await db.prepare('SELECT signed_at FROM completion_sheets WHERE project_id = ?').get(p.id);
  res.status(201).json({ signed: true, signed_at: sheet.signed_at });
}));

// ---- Contractor/admin: mark a milestone done ----
router.post('/:id/milestones/:mid/complete', authRequired, ah(async (req, res) => {
  const p = await loadProject(req, res);
  if (!p) return;
  if (!['admin', 'contractor'].includes(req.user.role)) return res.status(403).json({ error: 'Not allowed.' });
  const m = await db.prepare('SELECT * FROM milestones WHERE id = ? AND project_id = ?').get(req.params.mid, p.id);
  if (!m) return res.status(404).json({ error: 'Milestone not found.' });
  await db.prepare(`UPDATE milestones SET status = 'completed' WHERE id = ?`).run(m.id);
  await auditLog(req.user.id, 'milestone.completed', 'milestones', m.id, `Project #${p.id}: "${m.title}"`);

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
  await auditLog(req.user.id, approved ? 'milestone.approved' : 'milestone.rejected', 'milestones', m.id,
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
// Authorize BEFORE multer touches the disk.
async function preflightProject(req, res, next) {
  try {
    const p = await loadProject(req, res);
    if (!p) return;
    if (!['admin', 'contractor'].includes(req.user.role)) return res.status(403).json({ error: 'Not allowed.' });
    req.project = p;
    next();
  } catch (e) { next(e); }
}
router.post('/:id/photos', authRequired, preflightProject, upload.array('photos', 6), ah(async (req, res) => {
  const p = req.project;
  const kind = ['progress', 'completion'].includes((req.body || {}).kind) ? req.body.kind : 'progress';
  const saved = [];
  for (const f of req.files || []) {
    // Same storage path as request photos: honors S3 when configured.
    const { opt, filename, storageKey, storageProvider } = await require('../services/photostore').persist(f, 'project');
    const info = await db.prepare(
      `INSERT INTO photos (project_id, filename, original_name, mime, size_bytes, width, height, kind, uploaded_by, storage_key, storage_provider)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(p.id, filename, f.originalname, f.mimetype, opt.size, opt.width, opt.height, kind, req.user.id, storageKey, storageProvider);
    saved.push({ ...await db.prepare('SELECT id, original_name, mime, kind, created_at FROM photos WHERE id = ?').get(info.lastInsertRowid), optimized: opt.optimized });
  }
  res.status(201).json({ photos: saved });
}));

module.exports = router;
