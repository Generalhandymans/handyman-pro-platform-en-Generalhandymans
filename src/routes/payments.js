// Payments: manual bookkeeping + real Stripe charges.
//
// Without STRIPE_SECRET_KEY: everything works as before — admin records
// payments manually (provider='manual'). Nothing breaks.
// With STRIPE_SECRET_KEY set: customers pay deposits through Stripe
// PaymentIntents; the webhook marks them paid automatically.
const express = require('express');
const db = require('../db');
const { ah, authRequired, requireRole, isInt, isNonEmpty, failIfErrors } = require('../middleware');
const stripeSvc = require('../services/stripe');

const router = express.Router();

router.get('/stripe-status', ah(async (req, res) => {
  res.json({
    implemented: true,
    enabled: stripeSvc.isEnabled(),
    publishable_key: stripeSvc.isEnabled() ? (process.env.STRIPE_PUBLISHABLE_KEY || null) : null,
    message: stripeSvc.isEnabled()
      ? 'Stripe is connected. Deposits are charged through Stripe PaymentIntents.'
      : 'Stripe is not configured. Set STRIPE_SECRET_KEY (+ webhook secret) to charge cards. Payments are recorded manually meanwhile.',
  });
}));

// ---- Stripe webhook: NO auth (Stripe signs the payload). ----
// NOTE: server.js mounts express.raw() on this path BEFORE express.json(),
// so req.body is the raw Buffer Stripe needs for signature verification.
router.post('/webhook', ah(async (req, res) => {
  if (!stripeSvc.isEnabled()) return res.status(503).json({ error: 'Stripe is not configured.' });
  const sig = req.headers['stripe-signature'];
  const handled = stripeSvc.handleWebhook(req.body, sig);
  if (handled === null) return res.status(400).json({ error: 'Invalid webhook signature.' });
  res.json({ received: true, event: handled });
}));

// ---- Create a Stripe PaymentIntent for a project deposit (customer) ----
router.post('/deposit-intent', authRequired, ah(async (req, res) => {
  if (!stripeSvc.isEnabled()) {
    return res.status(503).json({ error: 'Online payments are not enabled yet. Please contact support to arrange your deposit.' });
  }
  const b = req.body || {};
  const errors = {};
  if (!isInt(b.project_id, 1, 1e9)) errors.project_id = 'Project is required.';
  if (!isInt(b.amount_cents, 100, 100000000)) errors.amount_cents = 'Amount (cents) required, minimum $1.';
  if (failIfErrors(res, errors)) return;

  // Customers may only pay for their OWN projects.
  const project = db.prepare(
    `SELECT p.* FROM projects p JOIN job_requests j ON j.id = p.job_request_id WHERE p.id = ?`
  ).get(b.project_id);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  if (req.user.role !== 'admin') {
    const job = db.prepare('SELECT customer_id FROM job_requests WHERE id = ?').get(project.job_request_id);
    if (!job || job.customer_id !== req.user.id) {
      return res.status(403).json({ error: 'Not allowed.' });
    }
  }
  try {
    const out = await stripeSvc.createDepositIntent({
      projectId: b.project_id,
      amountCents: b.amount_cents,
      customerEmail: req.user.email,
    });
    res.status(201).json(out);
  } catch (e) {
    console.error('[stripe]', e.message);
    res.status(502).json({ error: 'Payment service unavailable. Please try again.' });
  }
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
