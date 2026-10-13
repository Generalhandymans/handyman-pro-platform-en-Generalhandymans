// Payments: manual bookkeeping + real Stripe charges.
//
// Without STRIPE_SECRET_KEY: everything works as before — admin records
// payments manually (provider='manual'). Nothing breaks.
// With STRIPE_SECRET_KEY set: customers pay deposits through Stripe
// PaymentIntents; the webhook marks them paid automatically.
const express = require('express');
const { requireStaff, can } = require('../services/permissions');
const db = require('../db');
const { ah, authRequired, requireRole, requireVerifiedEmail, isInt, isNonEmpty, failIfErrors } = require('../middleware');
const stripeSvc = require('../services/stripe');
const { auditLog } = require('../services/audit');

const router = express.Router();

router.get('/stripe-status', ah(async (req, res) => {
  res.json({
    implemented: true,
    enabled: stripeSvc.isEnabled(),
    simulated: stripeSvc.isSimulated(),
    publishable_key: stripeSvc.isEnabled() ? (process.env.STRIPE_PUBLISHABLE_KEY || null) : null,
    message: stripeSvc.isEnabled()
      ? 'Stripe is connected. Deposits are charged through Stripe PaymentIntents.'
      : stripeSvc.isSimulated()
        ? 'SIMULATED payment mode (testing only — no real charge). Set STRIPE_SECRET_KEY for real payments.'
        : 'Stripe is not configured. Set STRIPE_SECRET_KEY (+ webhook secret) to charge cards. Payments are recorded manually meanwhile.',
  });
}));

// ---- Stripe webhook: NO auth (Stripe signs the payload). ----
// NOTE: server.js mounts express.raw() on this path BEFORE express.json(),
// so req.body is the raw Buffer Stripe needs for signature verification.
router.post('/webhook', ah(async (req, res) => {
  if (!stripeSvc.isEnabled()) return res.status(503).json({ error: 'Stripe is not configured.' });
  let handled;
  try {
    handled = await stripeSvc.handleWebhook(req.body, req.headers['stripe-signature']);
  } catch (e) {
    console.error('[stripe webhook]', e.message);
    // 500 => Stripe retries later, so a failed DB update never loses a payment.
    return res.status(500).json({ error: 'Webhook processing failed.' });
  }
  if (handled === null) return res.status(400).json({ error: 'Invalid webhook signature.' });
  res.json({ received: true, event: handled });
}));

// ---- Create a Stripe PaymentIntent for a project deposit (customer) ----
// The amount is ALWAYS derived from the accepted quote — never trusted from
// the client — so nobody can underpay by tampering with the request.
router.post('/deposit-intent', authRequired, requireVerifiedEmail, ah(async (req, res) => {
  if (!stripeSvc.isEnabled()) {
    return res.status(503).json({ error: 'Online payments are not enabled yet. Please contact support to arrange your deposit.' });
  }
  const b = req.body || {};
  const errors = {};
  if (!isInt(b.project_id, 1, 1e9)) errors.project_id = 'Project is required.';
  if (failIfErrors(res, errors)) return;

  // Customers may only pay for their OWN projects.
  const project = await db.prepare(
    `SELECT p.*, q.deposit_cents AS expected_deposit
     FROM projects p JOIN job_requests j ON j.id = p.job_request_id
     LEFT JOIN quotes q ON q.id = p.quote_id
     WHERE p.id = ?`
  ).get(b.project_id);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  if (req.user.role !== 'admin') {
    const job = await db.prepare('SELECT customer_id FROM job_requests WHERE id = ?').get(project.job_request_id);
    if (!job || job.customer_id !== req.user.id) {
      return res.status(403).json({ error: 'Not allowed.' });
    }
  }
  const amountCents = project.expected_deposit;
  if (!amountCents || amountCents < 100) {
    return res.status(400).json({ error: 'This project has no deposit to collect.' });
  }
  const already = await db.prepare(
    `SELECT id FROM payments WHERE project_id = ? AND kind = 'deposit' AND status IN ('paid','recorded')`
  ).get(project.id);
  if (already) return res.status(409).json({ error: 'The deposit for this project is already paid.' });
  // Supersede any earlier pending intents for this deposit (keeps the ledger clean).
  try {
    const stripe = stripeSvc.getClient();
    const pend = await db.prepare(
      `SELECT id, provider_ref FROM payments
       WHERE project_id = ? AND kind = 'deposit' AND provider = 'stripe' AND status = 'pending'`
    ).all(project.id);
    for (const row of pend) {
      try { await stripe.paymentIntents.cancel(row.provider_ref); } catch (e) { /* already gone */ }
      await db.prepare(`UPDATE payments SET status = 'failed', notes = COALESCE(notes,'') || ' | superseded by a new intent' WHERE id = ?`).run(row.id);
    }
    const out = await stripeSvc.createDepositIntent({
      projectId: project.id,
      amountCents,
      customerEmail: req.user.email,
    });
    res.status(201).json({ ...out, amount_cents: amountCents });
  } catch (e) {
    console.error('[stripe]', e.message);
    res.status(502).json({ error: 'Payment service unavailable. Please try again.' });
  }
}));

// ---- Final balance (customer): price - everything already paid + refunded ----
// Allowed only once EVERY milestone is approved by the customer.
async function paidSoFar(projectId) {
  const rows = await db.prepare(
    `SELECT kind, COALESCE(SUM(amount_cents),0) AS s FROM payments
     WHERE project_id = ? AND status IN ('paid','recorded') GROUP BY kind`
  ).all(projectId);
  const by = Object.fromEntries(rows.map(r => [r.kind, Number(r.s)]));
  return (by.deposit || 0) + (by.milestone || 0) + (by.final || 0) - (by.refund || 0);
}

router.post('/final-intent', authRequired, requireVerifiedEmail, ah(async (req, res) => {
  if (!stripeSvc.isEnabled()) {
    return res.status(503).json({ error: 'Online payments are not enabled yet. Please contact support to arrange your final payment.' });
  }
  const b = req.body || {};
  if (!isInt(b.project_id, 1, 1e9)) return res.status(422).json({ error: 'Validation failed', fields: { project_id: 'Project is required.' } });
  const project = await db.prepare('SELECT * FROM projects WHERE id = ?').get(b.project_id);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  const job = await db.prepare('SELECT customer_id FROM job_requests WHERE id = ?').get(project.job_request_id);
  if (req.user.role !== 'admin' && (!job || job.customer_id !== req.user.id)) {
    return res.status(403).json({ error: 'Not allowed.' });
  }
  if (await require('../services/disputes').openDisputeFor(project.id)) {
    return res.status(409).json({ error: 'There is an open dispute on this project. The final payment opens after it is resolved.', code: 'DISPUTE_HOLD' });
  }
  const ms = await db.prepare('SELECT customer_approval FROM milestones WHERE project_id = ?').all(project.id);
  if (!ms.length || ms.some(m => m.customer_approval !== 'approved')) {
    return res.status(409).json({ error: 'The final payment opens after every milestone is approved.' });
  }
  const sheet = await db.prepare('SELECT id FROM completion_sheets WHERE project_id = ?').get(project.id);
  if (!sheet && req.user.role !== 'admin') {
    return res.status(409).json({ error: 'Please sign the completion sheet before paying the final balance.' });
  }
  const balance = project.customer_price_cents - await paidSoFar(project.id);
  if (balance < 100) return res.status(409).json({ error: 'There is no balance left to collect.' });
  try {
    const stripe = stripeSvc.getClient();
    const pend = await db.prepare(
      `SELECT id, provider_ref FROM payments
       WHERE project_id = ? AND kind = 'final' AND provider = 'stripe' AND status = 'pending'`
    ).all(project.id);
    for (const row of pend) {
      try { await stripe.paymentIntents.cancel(row.provider_ref); } catch (e) { /* already gone */ }
      await db.prepare(`UPDATE payments SET status = 'failed', notes = COALESCE(notes,'') || ' | superseded by a new intent' WHERE id = ?`).run(row.id);
    }
    const out = await stripeSvc.createIntent({ projectId: project.id, amountCents: balance, kind: 'final', customerEmail: req.user.email });
    res.status(201).json({ ...out, amount_cents: balance });
  } catch (e) {
    console.error('[stripe]', e.message);
    res.status(502).json({ error: 'Payment service unavailable. Please try again.' });
  }
}));

// ---- Refund a PAID Stripe payment (admin). Omit amount_cents for a full refund. ----
router.post('/:id/refund', authRequired, requireStaff('finance'), ah(async (req, res) => {
  if (!stripeSvc.isEnabled()) return res.status(503).json({ error: 'Stripe is not configured.' });
  const pay = await db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
  if (!pay) return res.status(404).json({ error: 'Payment not found.' });
  if (pay.provider !== 'stripe' || pay.status !== 'paid' || pay.kind === 'refund') {
    return res.status(400).json({ error: 'Only paid Stripe charges can be refunded here. Record manual refunds with POST /api/payments.' });
  }
  const amount = (req.body || {}).amount_cents;
  if (amount !== undefined && !isInt(amount, 1, 100000000)) {
    return res.status(422).json({ error: 'Validation failed', fields: { amount_cents: 'Whole cents, at least 1.' } });
  }
  try {
    const out = await stripeSvc.refundPayment({ payment: pay, amountCents: amount });
    await auditLog(req.user.id, 'payment.refunded', 'payments', pay.id, `Refunded ${out.amount_cents} cents (${out.refund_id})`);
    res.status(201).json(out);
  } catch (e) {
    if (e.statusCode === 400) return res.status(400).json({ error: e.message });
    console.error('[stripe refund]', e.message);
    res.status(502).json({ error: 'Payment service unavailable. Please try again.' });
  }
}));

router.get('/', authRequired, ah(async (req, res) => {
  const { project_id } = req.query;
  let rows;
  if (req.user.role === 'admin') {
    rows = project_id
      ? await db.prepare('SELECT * FROM payments WHERE project_id = ? ORDER BY id').all(project_id)
      : await db.prepare('SELECT * FROM payments ORDER BY id DESC LIMIT 200').all();
  } else {
    // Customers only see payments for their OWN projects. Contractors never see
    // what the customer pays (that would expose the platform margin).
    if (req.user.role !== 'customer') return res.json([]);
    rows = await db.prepare(
      `SELECT pay.* FROM payments pay
       JOIN projects p ON p.id = pay.project_id
       JOIN job_requests j ON j.id = p.job_request_id
       WHERE j.customer_id = ? ${project_id ? 'AND pay.project_id = ?' : ''} ORDER BY pay.id`
    ).all(req.user.id, ...(project_id ? [project_id] : []));
  }
  res.json(rows);
}));

router.post('/', authRequired, requireStaff('finance'), ah(async (req, res) => {
  const b = req.body || {};
  const errors = {};
  if (!await db.prepare('SELECT id FROM projects WHERE id = ?').get(b.project_id)) errors.project_id = 'Project not found.';
  if (!['deposit', 'milestone', 'final', 'refund'].includes(b.kind)) errors.kind = 'Invalid kind.';
  if (!isInt(b.amount_cents, 1, 100000000)) errors.amount_cents = 'Amount (cents) required.';
  if (b.notes && !isNonEmpty(b.notes, 1000)) errors.notes = 'Notes too long.';
  if (failIfErrors(res, errors)) return;
  const info = await db.prepare(
    `INSERT INTO payments (project_id, kind, amount_cents, status, provider, notes)
     VALUES (?,?,?,'recorded','manual',?)`
  ).run(b.project_id, b.kind, b.amount_cents, (b.notes || '').trim());
  if (b.kind === 'deposit') {
    // A manually recorded deposit counts as paid for the pipeline (forward-only).
    const proj = await db.prepare('SELECT job_request_id FROM projects WHERE id = ?').get(b.project_id);
    if (proj) {
      await db.prepare(
        `UPDATE job_requests SET status = 'deposit_paid', updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status IN ('new','ai_analyzed','quote_sent')`
      ).run(proj.job_request_id);
    }
    // Confirm to the customer (payment + Terms of Service).
    const { depositConfirmationEmail } = require('../services/notify');
    await depositConfirmationEmail(b.project_id).catch(() => {});
  }
  await auditLog(req.user.id, 'payment.recorded', 'payments', info.lastInsertRowid, `${b.kind} ${b.amount_cents} cents (manual) on project #${b.project_id}`);
  res.status(201).json(await db.prepare('SELECT * FROM payments WHERE id = ?').get(info.lastInsertRowid));
}));

module.exports = router;
