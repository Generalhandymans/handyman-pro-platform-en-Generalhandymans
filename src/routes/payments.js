// Payments: BOOKKEEPING ONLY. Stripe is NOT integrated.
//
// Every money movement the platform records (deposit collected, milestone
// payment, refund) is stored here with provider='manual'. A real integration
// would create Stripe PaymentIntents and webhooks — see ROADMAP.md.
// Nothing in this file charges a card.
const express = require('express');
const db = require('../db');
const { ah, authRequired, requireRole, isInt, isNonEmpty, failIfErrors } = require('../middleware');

const router = express.Router();

router.get('/stripe-status', ah(async (req, res) => {
  res.json({
    implemented: false,
    message: 'Stripe is not integrated. Payments are recorded manually as bookkeeping entries (provider="manual"). See ROADMAP.md for the integration plan.',
  });
}));

router.get('/', authRequired, ah(async (req, res) => {
  const { project_id } = req.query;
  let rows;
  if (req.user.role === 'admin') {
    rows = project_id
      ? db.prepare('SELECT * FROM payments WHERE project_id = ? ORDER BY id').all(project_id)
      : db.prepare('SELECT * FROM payments ORDER BY id DESC LIMIT 200').all();
  } else {
    // Customers/contractors only see payments for their own projects.
    rows = db.prepare(
      `SELECT pay.* FROM payments pay
       JOIN projects p ON p.id = pay.project_id
       JOIN job_requests j ON j.id = p.job_request_id
       LEFT JOIN contractors c ON c.id = p.contractor_id
       WHERE (? = 'customer' AND j.customer_id = ?)
          OR (? = 'contractor' AND c.user_id = ?)
          ${project_id ? 'AND pay.project_id = ?' : ''} ORDER BY pay.id`
    ).all(req.user.role, req.user.id, req.user.role, req.user.id, ...(project_id ? [project_id] : []));
  }
  res.json(rows);
}));

router.post('/', authRequired, requireRole('admin'), ah(async (req, res) => {
  const b = req.body || {};
  const errors = {};
  if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(b.project_id)) errors.project_id = 'Project not found.';
  if (!['deposit', 'milestone', 'final', 'refund'].includes(b.kind)) errors.kind = 'Invalid kind.';
  if (!isInt(b.amount_cents, 1, 100000000)) errors.amount_cents = 'Amount (cents) required.';
  if (b.notes && !isNonEmpty(b.notes, 1000)) errors.notes = 'Notes too long.';
  if (failIfErrors(res, errors)) return;
  const info = db.prepare(
    `INSERT INTO payments (project_id, kind, amount_cents, status, provider, notes)
     VALUES (?,?,?,'recorded','manual',?)`
  ).run(b.project_id, b.kind, b.amount_cents, (b.notes || '').trim());
  res.status(201).json(db.prepare('SELECT * FROM payments WHERE id = ?').get(info.lastInsertRowid));
}));

module.exports = router;
