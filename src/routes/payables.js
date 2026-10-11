// Contractor payouts. Admin: list, approve, mark paid (with method + reference),
// cancel, yearly totals (CSV for tax prep). Contractor: their own payouts only.
// The platform RECORDS payouts; moving the money (ACH, check, Zelle...) happens
// outside — or via Stripe Connect in a later phase.
'use strict';
const express = require('express');
const { requireStaff, can } = require('../services/permissions');
const db = require('../db');
const { ah, authRequired, requireRole, isInt, isNonEmpty, failIfErrors } = require('../middleware');
const { auditLog } = require('../services/audit');
const { notify, shell } = require('../services/notify');
const { customerBalanceCents, ensurePayable } = require('../services/payables');

const router = express.Router();
router.use(authRequired);

const METHODS = ['ach', 'check', 'zelle', 'cash', 'other'];
// SQLite stores 'YYYY-MM-DD HH:MM:SS' (UTC) text; PostgreSQL returns Date objects.
const toDate = (v) => {
  if (v instanceof Date) return v;
  const s = String(v).replace(' ', 'T');
  return new Date(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z');
};
const money = (c) => '$' + (Number(c) / 100).toFixed(2);

// ---- Contractor: my payouts ----
router.get('/mine', requireRole('contractor'), ah(async (req, res) => {
  const c = await db.prepare('SELECT id FROM contractors WHERE user_id = ?').get(req.user.id);
  if (!c) return res.json({ payables: [], totals: { pending_cents: 0, paid_cents: 0 } });
  const rows = await db.prepare(
    `SELECT id, project_id, payable_cents, status, due_at, paid_at, paid_method, paid_reference
     FROM contractor_payables WHERE contractor_id = ? ORDER BY id DESC`
  ).all(c.id);
  const sum = (st) => rows.filter(r => st.includes(r.status)).reduce((a, r) => a + Number(r.payable_cents), 0);
  res.json({ payables: rows, totals: { pending_cents: sum(['pending', 'approved']), paid_cents: sum(['paid']) } });
}));

// ---- Everything below is admin only ----
router.use(requireStaff('finance'));

router.get('/', ah(async (req, res) => {
  const status = ['pending', 'approved', 'paid', 'cancelled'].includes(req.query.status) ? req.query.status : null;
  const rows = await db.prepare(
    `SELECT pb.*, COALESCE(c.legal_name, u.name) AS contractor_name, j.service_type
     FROM contractor_payables pb
     JOIN contractors c ON c.id = pb.contractor_id
     JOIN users u ON u.id = c.user_id
     JOIN projects p ON p.id = pb.project_id
     JOIN job_requests j ON j.id = p.job_request_id
     ${status ? 'WHERE pb.status = ?' : ''} ORDER BY pb.id DESC LIMIT 200`
  ).all(...(status ? [status] : []));
  for (const r of rows) r.customer_balance_cents = await customerBalanceCents(r.project_id);
  const sum = (st) => rows.filter(r => st.includes(r.status)).reduce((a, r) => a + Number(r.payable_cents), 0);
  res.json({ payables: rows, totals: { owed_cents: sum(['pending', 'approved']), paid_cents: sum(['paid']) } });
}));

// Backfill: payables for projects that completed before this feature existed.
router.post('/generate', ah(async (req, res) => {
  const projects = await db.prepare(
    `SELECT p.* FROM projects p
     WHERE p.stage = 'completed' AND p.contractor_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM contractor_payables pb WHERE pb.project_id = p.id)`
  ).all();
  let created = 0;
  for (const p of projects) if (await ensurePayable(p)) created++;
  await auditLog(req.user.id, 'payable.backfill', 'contractor_payables', null, `Created ${created}`);
  res.json({ created });
}));

router.post('/:id/approve', ah(async (req, res) => {
  const r = await db.prepare(`UPDATE contractor_payables SET status = 'approved' WHERE id = ? AND status = 'pending'`).run(req.params.id);
  if (r.changes !== 1) return res.status(409).json({ error: 'Only a pending payable can be approved.' });
  await auditLog(req.user.id, 'payable.approved', 'contractor_payables', Number(req.params.id), 'Approved for payment');
  res.json(await db.prepare('SELECT * FROM contractor_payables WHERE id = ?').get(req.params.id));
}));

router.post('/:id/pay', ah(async (req, res) => {
  const b = req.body || {};
  const errors = {};
  if (!METHODS.includes(b.method)) errors.method = 'Choose one of: ' + METHODS.join(', ') + '.';
  if (b.reference && !isNonEmpty(b.reference, 200)) errors.reference = 'Reference is too long.';
  if (failIfErrors(res, errors)) return;
  const pb = await db.prepare('SELECT * FROM contractor_payables WHERE id = ?').get(req.params.id);
  if (!pb) return res.status(404).json({ error: 'Payable not found.' });
  if (!['pending', 'approved'].includes(pb.status)) return res.status(409).json({ error: 'This payable is already ' + pb.status + '.' });

  // Guard: do not pay the contractor while the customer still owes money,
  // unless an admin overrides on purpose (audited).
  const balance = await customerBalanceCents(pb.project_id);
  if (balance >= 100 && b.force !== true) {
    return res.status(409).json({
      error: `The customer still owes ${money(balance)} on this project. Pay anyway only if you accept that risk (send force:true).`,
      customer_balance_cents: balance,
    });
  }
  // Atomic claim: two admins clicking at once cannot pay twice.
  const upd = await db.prepare(
    `UPDATE contractor_payables SET status = 'paid', paid_at = CURRENT_TIMESTAMP, paid_method = ?, paid_reference = ?, paid_by = ?
     WHERE id = ? AND status IN ('pending','approved')`
  ).run(b.method, (b.reference || '').trim() || null, req.user.id, pb.id);
  if (upd.changes !== 1) return res.status(409).json({ error: 'This payable was just updated by someone else.' });
  await auditLog(req.user.id, balance >= 100 ? 'payable.paid_forced' : 'payable.paid', 'contractor_payables', pb.id,
    `${money(pb.payable_cents)} via ${b.method}${balance >= 100 ? ` (customer owed ${money(balance)})` : ''}`);

  const cu = await db.prepare('SELECT u.name, u.email FROM contractors c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(pb.contractor_id);
  if (cu && cu.email) {
    await notify({
      to: cu.email,
      subject: `Payout sent — project #${pb.project_id} (${money(pb.payable_cents)})`,
      html: shell('Your payout was sent', `Hi ${String(cu.name || '').split(' ')[0]}, we paid your work on this project.`, [
        ['Project', `#${pb.project_id}`], ['Amount', money(pb.payable_cents)], ['Method', b.method],
        ...(b.reference ? [['Reference', String(b.reference).slice(0, 200)]] : []),
      ]),
    }).catch(() => {});
  }
  res.json(await db.prepare('SELECT * FROM contractor_payables WHERE id = ?').get(pb.id));
}));

router.post('/:id/cancel', ah(async (req, res) => {
  const notes = (req.body || {}).notes;
  if (!isNonEmpty(notes, 500)) return res.status(422).json({ error: 'Validation failed', fields: { notes: 'Say why it is cancelled.' } });
  const r = await db.prepare(`UPDATE contractor_payables SET status = 'cancelled', notes = ? WHERE id = ? AND status IN ('pending','approved')`).run(notes.trim(), req.params.id);
  if (r.changes !== 1) return res.status(409).json({ error: 'Only an unpaid payable can be cancelled.' });
  await auditLog(req.user.id, 'payable.cancelled', 'contractor_payables', Number(req.params.id), notes.trim());
  res.json(await db.prepare('SELECT * FROM contractor_payables WHERE id = ?').get(req.params.id));
}));

// ---- Yearly totals paid per contractor (tax prep). ?year=2026  ?format=csv ----
router.get('/summary', ah(async (req, res) => {
  const year = isInt(Number(req.query.year), 2000, 2100) ? Number(req.query.year) : new Date().getUTCFullYear();
  const rows = await db.prepare(
    `SELECT pb.paid_at, pb.payable_cents, c.id AS contractor_id, COALESCE(c.legal_name, u.name) AS name, u.email
     FROM contractor_payables pb JOIN contractors c ON c.id = pb.contractor_id JOIN users u ON u.id = c.user_id
     WHERE pb.status = 'paid'`
  ).all();
  const by = new Map();
  for (const r of rows) {
    if (toDate(r.paid_at).getUTCFullYear() !== year) continue;
    const e = by.get(r.contractor_id) || { contractor_id: r.contractor_id, name: r.name, email: r.email, payouts: 0, total_cents: 0 };
    e.payouts++; e.total_cents += Number(r.payable_cents);
    by.set(r.contractor_id, e);
  }
  const list = [...by.values()].sort((a, b) => b.total_cents - a.total_cents);
  if (req.query.format === 'csv') {
    // CSV-injection safe: any cell starting with = + - @ is prefixed with a quote.
    const cell = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
    const csv = ['contractor_id,name,email,payouts,total_usd']
      .concat(list.map(e => [e.contractor_id, e.name, e.email, e.payouts, (e.total_cents / 100).toFixed(2)].map(cell).join(','))).join('\n');
    res.type('text/csv').set('Content-Disposition', `attachment; filename="payouts-${year}.csv"`).send(csv + '\n');
    return;
  }
  res.json({ year, contractors: list, total_cents: list.reduce((a, e) => a + e.total_cents, 0) });
}));

module.exports = router;
