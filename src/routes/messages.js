// Mediated messaging — BUSINESS RULE: direct client<->contractor contact is
// PROHIBITED. The platform owns the customer relationship. Every project gets
// up to two threads, and support (admin) always sits in the middle:
//
//   client_support      : customer  <->  support(admin)
//   support_contractor  : support(admin) <-> contractor
//
// Access matrix (enforced on EVERY endpoint):
//   customer   : only 'client_support' threads of their OWN projects
//   contractor : only 'support_contractor' threads of projects ASSIGNED to them
//   admin      : both kinds, all projects
//
// There is no endpoint, parameter, or combination that yields a direct
// client<->contractor thread — the schema only allows the two kinds above.
const express = require('express');
const db = require('../db');
const { ah, authRequired, isNonEmpty, failIfErrors } = require('../middleware');
const { notify, shell, projectParties } = require('../services/notify');

const router = express.Router();
router.use(authRequired);

function contractorIdFor(userId) {
  const c = db.prepare('SELECT id FROM contractors WHERE user_id = ?').get(userId);
  return c ? c.id : null;
}

// Returns the project if visible, else null. Visibility == messaging eligibility.
function visibleProject(req, projectId) {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!p) return null;
  if (req.user.role === 'admin') return p;
  if (req.user.role === 'contractor') {
    const cid = contractorIdFor(req.user.id);
    return cid && p.contractor_id === cid ? p : null;
  }
  // customer
  const job = db.prepare('SELECT customer_id FROM job_requests WHERE id = ?').get(p.job_request_id);
  return job && job.customer_id === req.user.id ? p : null;
}

// Which thread kind may this role use? (null = none)
function allowedKind(role) {
  if (role === 'customer') return 'client_support';
  if (role === 'contractor') return 'support_contractor';
  return null; // admin: either, chosen explicitly
}

function loadThread(req, res) {
  const t = db.prepare('SELECT * FROM message_threads WHERE id = ?').get(req.params.tid);
  if (!t) { res.status(404).json({ error: 'Thread not found.' }); return null; }
  const p = visibleProject(req, t.project_id);
  if (!p) { res.status(403).json({ error: 'Not allowed.' }); return null; }
  const kind = allowedKind(req.user.role);
  if (kind && t.kind !== kind) { res.status(403).json({ error: 'Not allowed.' }); return null; }
  return { thread: t, project: p };
}

// ---- List my threads for a project ----
router.get('/projects/:id/threads', ah(async (req, res) => {
  const p = visibleProject(req, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  let rows = db.prepare(
    `SELECT t.*, (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count,
            (SELECT MAX(created_at) FROM messages m WHERE m.thread_id = t.id) AS last_message_at
     FROM message_threads t WHERE t.project_id = ? ORDER BY t.id`
  ).all(p.id);
  const kind = allowedKind(req.user.role);
  if (kind) rows = rows.filter(r => r.kind === kind);
  res.json(rows);
}));

// ---- Get-or-create a thread for a project ----
router.post('/projects/:id/threads', ah(async (req, res) => {
  const p = visibleProject(req, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  const roleKind = allowedKind(req.user.role);
  const want = (req.body || {}).kind;
  const kind = req.user.role === 'admin'
    ? (['client_support', 'support_contractor'].includes(want) ? want : 'client_support')
    : roleKind;
  if (!kind) return res.status(403).json({ error: 'Not allowed.' });

  let t = db.prepare('SELECT * FROM message_threads WHERE project_id = ? AND kind = ?').get(p.id, kind);
  if (!t) {
    const info = db.prepare('INSERT INTO message_threads (project_id, kind) VALUES (?,?)').run(p.id, kind);
    t = db.prepare('SELECT * FROM message_threads WHERE id = ?').get(info.lastInsertRowid);
  }
  res.status(201).json(t);
}));

// ---- List messages in a thread ----
router.get('/threads/:tid/messages', ah(async (req, res) => {
  const found = loadThread(req, res);
  if (!found) return;
  const rows = db.prepare(
    `SELECT m.id, m.body, m.sender_role, m.created_at, u.name AS sender_name
     FROM messages m LEFT JOIN users u ON u.id = m.sender_id
     WHERE m.thread_id = ? ORDER BY m.id`
  ).all(found.thread.id);
  res.json(rows);
}));

// ---- Post a message (notifies the other party by email) ----
router.post('/threads/:tid/messages', ah(async (req, res) => {
  const found = loadThread(req, res);
  if (!found) return;
  const { thread, project } = found;
  const errors = {};
  if (!isNonEmpty((req.body || {}).body, 2000)) errors.body = 'Message text is required (max 2000 chars).';
  if (failIfErrors(res, errors)) return;

  // The sender_role must match the authenticated role — no impersonation.
  const senderRole = req.user.role === 'admin' ? 'admin' : req.user.role;
  const info = db.prepare(
    'INSERT INTO messages (thread_id, sender_id, sender_role, body) VALUES (?,?,?,?)'
  ).run(thread.id, req.user.id, senderRole, req.body.body.trim());
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);

  // Notify the OTHER party by email (support always in the middle).
  const parties = projectParties(project.id);
  const jobLabel = parties.job ? `#${parties.job.id} ${parties.job.service_type}` : `project #${project.id}`;
  let recipients = [];
  if (thread.kind === 'client_support') {
    if (senderRole === 'customer') recipients = parties.admins;
    else if (senderRole === 'admin' && parties.customer && parties.customer.email) recipients = [parties.customer];
  } else {
    if (senderRole === 'contractor') recipients = parties.admins;
    else if (senderRole === 'admin' && parties.contractor && parties.contractor.email) recipients = [parties.contractor];
  }
  for (const r of recipients) {
    notify({
      to: r.email,
      subject: `New message — General Handyman Solutions ${jobLabel}`,
      html: shell('New message', `${req.user.name} wrote in the ${thread.kind === 'client_support' ? 'customer support' : 'contractor support'} thread:`, [
        ['Project', jobLabel],
        ['From', `${req.user.name} (${senderRole})`],
        ['Message', req.body.body.trim().slice(0, 500)],
      ]),
    }).catch(() => {});
  }

  res.status(201).json(msg);
}));

module.exports = router;
