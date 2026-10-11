// Disputes: customers (or the assigned contractor) report a problem on a project.
// While a dispute is open the contractor payout and the final payment are on HOLD.
// Support investigates and talks to each side SEPARATELY (the mediated-contact rule);
// a resolution can request rework, or refund part/all of what the customer paid,
// and adjust what the contractor is owed.
'use strict';
const express = require('express');
const db = require('../db');
const { ah, authRequired, isInt, isNonEmpty, failIfErrors } = require('../middleware');
const { can, denial, requireStaff } = require('../services/permissions');
const { auditLog } = require('../services/audit');
const { notify, shell } = require('../services/notify');
const svc = require('../services/disputes');

const router = express.Router();
router.use(authRequired);

const REASONS = ['quality', 'incomplete', 'no_show', 'damage', 'billing', 'other'];
const RESOLUTIONS = ['no_action', 'rework', 'partial_refund', 'full_refund'];
const money = (c) => '$' + (Number(c) / 100).toFixed(2);
const ACTIVE_STAGES = ['in_progress', 'review', 'completed'];

// ---- who is who on a project ----
async function parties(projectId) {
  const p = await db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!p) return null;
  const job = await db.prepare('SELECT id, customer_id, name, email, service_type FROM job_requests WHERE id = ?').get(p.job_request_id);
  const con = p.contractor_id
    ? await db.prepare('SELECT c.id, c.user_id, u.name, u.email FROM contractors c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(p.contractor_id)
    : null;
  const cust = job && job.customer_id ? await db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(job.customer_id) : null;
  return { p, job, con, cust };
}
async function roleOn(user, projectId) {
  const pt = await parties(projectId);
  if (!pt) return { pt: null };
  if (user.role === 'admin') return { pt, role: 'admin' };
  if (user.role === 'customer' && pt.job && pt.job.customer_id === user.id) return { pt, role: 'customer' };
  if (user.role === 'contractor' && pt.con && pt.con.user_id === user.id) return { pt, role: 'contractor' };
  return { pt, role: null };
}

// ---- role-scoped views (mediated: each side sees only its own channel; contractors never see money) ----
function viewFor(d, role) {
  if (role === 'admin') return d;
  if (role === 'customer') {
    const { opened_by, resolved_by, ...rest } = d;
    if (d.opened_by_role === 'contractor') rest.description = undefined; // support relays it
    return rest;
  }
  // contractor: reason + status only; the complaint text and money are relayed by support
  const res = d.resolution === 'partial_refund' || d.resolution === 'full_refund' ? 'resolved_with_adjustment' : d.resolution;
  return {
    id: d.id, project_id: d.project_id, reason: d.reason, status: d.status, opened_by_role: d.opened_by_role,
    description: d.opened_by_role === 'contractor' ? d.description : undefined,
    resolution: res, created_at: d.created_at, resolved_at: d.resolved_at,
  };
}
const visibleChannels = (role) => (role === 'admin' ? ['customer', 'contractor', 'staff'] : [role]);
async function eventsFor(disputeId, role) {
  const ch = visibleChannels(role);
  return db.prepare(
    `SELECT e.id, e.author_role, e.visibility, e.body, e.created_at, u.name AS author_name
     FROM dispute_events e LEFT JOIN users u ON u.id = e.author_id
     WHERE e.dispute_id = ? AND e.visibility IN (${ch.map(() => '?').join(',')}) ORDER BY e.id`
  ).all(disputeId, ...ch);
}
async function emailAdmins(subject, lead, rows) {
  const admins = await db.prepare("SELECT email FROM users WHERE role = 'admin' AND (staff_role IS NULL OR staff_role <> 'disabled')").all();
  for (const a of admins) await notify({ to: a.email, subject, html: shell(subject, lead, rows) }).catch(() => {});
}

// ---- list (staff: all; customer/contractor: their projects) ----
router.get('/', ah(async (req, res) => {
  const status = ['open', 'investigating', 'resolved', 'withdrawn'].includes(req.query.status) ? req.query.status : null;
  const where = [], args = [];
  if (status) { where.push('d.status = ?'); args.push(status); }
  let join = '';
  if (req.user.role === 'customer') { join = 'JOIN projects p ON p.id = d.project_id JOIN job_requests j ON j.id = p.job_request_id'; where.push('j.customer_id = ?'); args.push(req.user.id); }
  else if (req.user.role === 'contractor') { join = 'JOIN projects p ON p.id = d.project_id JOIN contractors c ON c.id = p.contractor_id'; where.push('c.user_id = ?'); args.push(req.user.id); }
  else if (!can(req.user, 'read')) return res.status(403).json({ error: 'You do not have permission to do that.' });
  const rows = await db.prepare(
    `SELECT d.* FROM disputes d ${join} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY d.id DESC LIMIT 200`
  ).all(...args);
  const role = req.user.role === 'admin' ? 'admin' : req.user.role;
  res.json(rows.map(d => viewFor(d, role)));
}));

router.get('/:id', ah(async (req, res) => {
  const d = await db.prepare('SELECT * FROM disputes WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Dispute not found.' });
  const { role } = await roleOn(req.user, d.project_id);
  if (!role) return res.status(404).json({ error: 'Dispute not found.' });
  if (role === 'admin' && !can(req.user, 'read')) return res.status(403).json({ error: 'You do not have permission to do that.' });
  const out = viewFor(d, role);
  out.events = await eventsFor(d.id, role);
  res.json(out);
}));

// ---- open ----
router.post('/', ah(async (req, res) => {
  const b = req.body || {};
  const errors = {};
  if (!isInt(b.project_id, 1, 1e9)) errors.project_id = 'Project is required.';
  if (!REASONS.includes(b.reason)) errors.reason = 'Choose a reason.';
  if (!isNonEmpty(b.description, 2000) || String(b.description).trim().length < 10) errors.description = 'Describe the problem (at least 10 characters).';
  if (failIfErrors(res, errors)) return;
  if (!['customer', 'contractor'].includes(req.user.role)) return res.status(403).json({ error: 'Only the customer or the contractor can open a dispute.' });
  const { pt, role } = await roleOn(req.user, b.project_id);
  if (!pt) return res.status(404).json({ error: 'Project not found.' });
  if (!role) return res.status(403).json({ error: 'Not allowed.' });
  if (!ACTIVE_STAGES.includes(pt.p.stage)) return res.status(409).json({ error: 'A dispute can be opened once the work has started.' });
  if (role === 'contractor' && pt.p.contractor_status !== 'accepted') return res.status(409).json({ error: 'Accept the job offer first.' });
  let id;
  try {
    const info = await db.prepare(
      `INSERT INTO disputes (project_id, opened_by, opened_by_role, reason, description) VALUES (?,?,?,?,?)`
    ).run(pt.p.id, req.user.id, role, b.reason, b.description.trim());
    id = info.lastInsertRowid;
  } catch (e) {
    return res.status(409).json({ error: 'There is already an open dispute on this project.' });
  }
  await auditLog(req.user.id, 'dispute.opened', 'disputes', id, `${role}: ${b.reason}`);
  await emailAdmins(`Dispute opened — project #${pt.p.id}`, `A ${role} reported a problem. Payments on this project are on hold until it is resolved.`, [
    ['Project', `#${pt.p.id} — ${pt.job ? pt.job.service_type : ''}`], ['Opened by', role], ['Reason', b.reason], ['Details', b.description.trim().slice(0, 500)],
  ]);
  res.status(201).json(viewFor(await db.prepare('SELECT * FROM disputes WHERE id = ?').get(id), role));
}));

// ---- comment ----
router.post('/:id/comments', ah(async (req, res) => {
  const d = await db.prepare('SELECT * FROM disputes WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Dispute not found.' });
  const { pt, role } = await roleOn(req.user, d.project_id);
  if (!role) return res.status(404).json({ error: 'Dispute not found.' });
  if (!['open', 'investigating'].includes(d.status)) return res.status(409).json({ error: 'This dispute is closed.' });
  const b = req.body || {};
  if (!isNonEmpty(b.body, 2000)) return res.status(422).json({ error: 'Validation failed', fields: { body: 'Write a message.' } });
  let visibility = role; // customer -> 'customer' channel, contractor -> 'contractor' channel
  if (role === 'admin') {
    const deny = denial(req.user, 'support');
    if (deny) return res.status(403).json(deny);
    visibility = b.visibility;
    if (!['customer', 'contractor', 'staff'].includes(visibility)) return res.status(422).json({ error: 'Validation failed', fields: { visibility: 'Choose customer, contractor or staff.' } });
  }
  const info = await db.prepare(
    'INSERT INTO dispute_events (dispute_id, author_id, author_role, visibility, body) VALUES (?,?,?,?,?)'
  ).run(d.id, req.user.id, role, visibility, b.body.trim());
  await db.prepare('UPDATE disputes SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(d.id);
  if (role === 'admin') {
    const target = visibility === 'customer' ? pt.cust : visibility === 'contractor' ? pt.con : null;
    if (target && target.email) {
      await notify({ to: target.email, subject: `Update on your dispute — project #${pt.p.id}`,
        html: shell('We replied to your dispute', 'Our support team added a message. Open your portal to read and reply.', []) }).catch(() => {});
    }
  } else {
    await emailAdmins(`New dispute message — project #${pt.p.id}`, `The ${role} added a message.`, [['Message', b.body.trim().slice(0, 500)]]);
  }
  res.status(201).json({ id: info.lastInsertRowid, visibility });
}));

// ---- staff: start investigating ----
router.post('/:id/status', requireStaff('support'), ah(async (req, res) => {
  if ((req.body || {}).status !== 'investigating') return res.status(422).json({ error: 'Validation failed', fields: { status: 'Only "investigating" can be set here; use /resolve to close.' } });
  const r = await db.prepare(`UPDATE disputes SET status = 'investigating', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'open'`).run(req.params.id);
  if (r.changes !== 1) return res.status(409).json({ error: 'Only an open dispute can move to investigating.' });
  await auditLog(req.user.id, 'dispute.investigating', 'disputes', Number(req.params.id), 'Investigation started');
  res.json({ id: Number(req.params.id), status: 'investigating' });
}));

// ---- the opener may withdraw ----
router.post('/:id/withdraw', ah(async (req, res) => {
  const d = await db.prepare('SELECT * FROM disputes WHERE id = ?').get(req.params.id);
  if (!d || d.opened_by !== req.user.id) return res.status(404).json({ error: 'Dispute not found.' });
  const r = await db.prepare(`UPDATE disputes SET status = 'withdrawn', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('open','investigating')`).run(d.id);
  if (r.changes !== 1) return res.status(409).json({ error: 'This dispute is already closed.' });
  await auditLog(req.user.id, 'dispute.withdrawn', 'disputes', d.id, 'Withdrawn by the person who opened it');
  res.json({ id: d.id, status: 'withdrawn' });
}));

// ---- staff: resolve (rework / refund / no action) + what the contractor is owed ----
router.post('/:id/resolve', ah(async (req, res) => {
  if (!can(req.user, 'support') && !can(req.user, 'finance')) return res.status(403).json({ error: 'Your team role cannot resolve disputes.', code: 'STAFF_ROLE' });
  const d = await db.prepare('SELECT * FROM disputes WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Dispute not found.' });
  if (!['open', 'investigating'].includes(d.status)) return res.status(409).json({ error: 'This dispute is already closed.' });
  const b = req.body || {};
  const errors = {};
  if (!RESOLUTIONS.includes(b.resolution)) errors.resolution = 'Choose: ' + RESOLUTIONS.join(', ') + '.';
  if (!isNonEmpty(b.notes, 2000)) errors.notes = 'Explain the decision (the customer sees this).';
  if (b.resolution === 'partial_refund' && !isInt(b.refund_cents, 1, 100000000)) errors.refund_cents = 'Whole cents, at least 1.';
  if (b.payable_action !== undefined && !['keep', 'cancel', 'reduce'].includes(b.payable_action)) errors.payable_action = 'Choose keep, cancel or reduce.';
  if (b.payable_action === 'reduce' && !isInt(b.payable_cents, 0, 100000000)) errors.payable_cents = 'The new amount in cents.';
  if (failIfErrors(res, errors)) return;

  // A resolution that gives money back is a FINANCE action (and needs 2-step if the policy is on).
  const isRefund = b.resolution === 'partial_refund' || b.resolution === 'full_refund';
  if (isRefund || (b.payable_action && b.payable_action !== 'keep')) {
    const deny = denial(req.user, 'finance');
    if (deny) return res.status(403).json({ ...deny, error: 'Refunds and payout changes need the finance role. ' + deny.error });
  }
  const pt = await parties(d.project_id);
  let refund = { via_stripe_cents: 0, manual_cents: 0, total_cents: 0 };

  if (isRefund) {
    const already = await svc.refundedForDispute(d.project_id, d.id);
    const ceiling = (await svc.netPaidCents(d.project_id)) + already; // what could ever be given back
    const target = b.resolution === 'full_refund' ? ceiling : Number(b.refund_cents);
    if (target > ceiling) return res.status(409).json({ error: `The customer has only paid ${money(ceiling)} net on this project.`, max_refund_cents: ceiling });
    if (target < 1) return res.status(409).json({ error: 'There is nothing to refund.' });
    const need = target - already; // a retry after a partial failure only sends the difference
    try {
      if (need > 0) { const r = await svc.executeRefund({ projectId: d.project_id, amountCents: need, disputeId: d.id }); refund = { ...r }; }
    } catch (e) {
      console.error('[dispute refund]', e.message);
      return res.status(502).json({ error: 'The payment service failed part-way. Nothing was closed; check the payments list and try again — already-sent refunds are not repeated.' });
    }
    refund.total_cents = target;
  }

  // Atomic close: two staff resolving at once cannot both win.
  const upd = await db.prepare(
    `UPDATE disputes SET status = 'resolved', resolution = ?, resolution_notes = ?, refund_cents = ?, resolved_by = ?,
            resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('open','investigating')`
  ).run(b.resolution, b.notes.trim(), refund.total_cents, req.user.id, d.id);
  if (upd.changes !== 1) return res.status(409).json({ error: 'This dispute was just closed by someone else.' });

  // What the contractor is owed.
  const payable = await db.prepare('SELECT * FROM contractor_payables WHERE project_id = ?').get(d.project_id);
  let payableOut = null;
  if (payable && b.payable_action && b.payable_action !== 'keep') {
    if (payable.status === 'paid') {
      payableOut = { already_paid: true, note: 'The contractor was already paid: recover the amount outside the app.' };
    } else if (['pending', 'approved'].includes(payable.status)) {
      if (b.payable_action === 'cancel') {
        await db.prepare(`UPDATE contractor_payables SET status = 'cancelled', notes = ? WHERE id = ? AND status IN ('pending','approved')`).run(`Dispute #${d.id}: ${b.notes.trim().slice(0, 300)}`, payable.id);
        payableOut = { action: 'cancelled' };
      } else if (Number(b.payable_cents) < Number(payable.payable_cents)) {
        await db.prepare(`UPDATE contractor_payables SET payable_cents = ?, notes = ? WHERE id = ? AND status IN ('pending','approved')`).run(Number(b.payable_cents), `Dispute #${d.id}: reduced`, payable.id);
        payableOut = { action: 'reduced', payable_cents: Number(b.payable_cents) };
      } else {
        payableOut = { action: 'unchanged', note: 'A reduction must be lower than the current amount.' };
      }
    }
  }

  // Rework: the project goes back to in_progress so the contractor fixes it.
  if (b.resolution === 'rework' && pt && pt.p.stage !== 'cancelled') {
    await db.prepare(`UPDATE projects SET stage = 'in_progress' WHERE id = ?`).run(pt.p.id);
    await db.prepare(`UPDATE job_requests SET status = 'in_progress', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(pt.p.job_request_id);
  }

  await auditLog(req.user.id, 'dispute.resolved', 'disputes', d.id,
    `${b.resolution}${refund.total_cents ? ' ' + money(refund.total_cents) : ''}${b.payable_action && b.payable_action !== 'keep' ? ', payout ' + b.payable_action : ''}`);

  if (pt && pt.cust && pt.cust.email) {
    await notify({ to: pt.cust.email, subject: `Your dispute was resolved — project #${pt.p.id}`,
      html: shell('Dispute resolved', 'Our team reviewed your report.', [
        ['Decision', b.resolution.replace('_', ' ')], ...(refund.total_cents ? [['Refund', money(refund.total_cents)]] : []), ['Notes', b.notes.trim().slice(0, 500)],
      ]) }).catch(() => {});
  }
  if (pt && pt.con && pt.con.email) {
    await notify({ to: pt.con.email, subject: `Dispute closed — project #${pt.p.id}`,
      html: shell('Dispute closed', b.resolution === 'rework' ? 'Support asked for rework on this project. Check your jobs for details.' : 'The dispute on this project was closed.', []) }).catch(() => {});
  }
  res.json({ dispute: await db.prepare('SELECT * FROM disputes WHERE id = ?').get(d.id), refund, payable: payableOut });
}));

module.exports = router;
