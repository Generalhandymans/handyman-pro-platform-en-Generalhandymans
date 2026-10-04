// Quotes: platform prices the job (customer price vs contractor cost = margin).
const express = require('express');
const db = require('../db');
const { ah, authRequired, requireRole, isInt, failIfErrors } = require('../middleware');
const { touchInteraction } = require('../services/crm');

const router = express.Router();

function fmt(c) { return '$' + (c / 100).toFixed(2); }

// Default milestone templates per trade (customer-approval checkpoints).
const MILESTONES = {
  painting: ['Prep and protection', 'Painting', 'Touch-up and final walkthrough'],
  plumbing: ['Diagnostic and parts', 'Repair / installation', 'Testing and cleanup'],
  electrical: ['Diagnostic and parts', 'Installation', 'Testing and cleanup'],
  bathroom: ['Demolition', 'Rough-in (plumbing/electrical)', 'Tile and fixtures', 'Finishes and cleanup'],
  kitchen: ['Demolition', 'Rough-in', 'Cabinets and counters', 'Finishes and cleanup'],
  flooring: ['Removal and prep', 'Installation', 'Transitions and cleanup'],
  drywall: ['Hang and tape', 'Mud, sand and texture', 'Prime and cleanup'],
  carpentry: ['Material prep', 'Installation', 'Finish and cleanup'],
};
const GENERIC_MILESTONES = ['Preparation', 'Main work', 'Finishing and client review'];

function jobVisibleTo(req, job) {
  if (req.user.role === 'admin') return true;
  return job.customer_id && job.customer_id === req.user.id;
}

// ---- Admin: create a quote from a job (optionally linked to an estimate) ----
router.post('/', authRequired, requireRole('admin'), ah(async (req, res) => {
  const b = req.body || {};
  const errors = {};
  const job = db.prepare('SELECT * FROM job_requests WHERE id = ?').get(b.job_request_id);
  if (!job) errors.job_request_id = 'Job request not found.';
  if (!isInt(b.customer_price_cents, 100, 100000000)) errors.customer_price_cents = 'Customer price (cents) required.';
  if (!isInt(b.contractor_cost_cents, 0, 100000000)) errors.contractor_cost_cents = 'Contractor cost (cents) required.';
  const depositPct = b.deposit_pct === undefined ? 30 : b.deposit_pct;
  if (!isInt(depositPct, 0, 100)) errors.deposit_pct = 'Deposit % must be 0-100.';
  if (b.customer_price_cents && b.contractor_cost_cents && b.contractor_cost_cents > b.customer_price_cents) {
    errors.contractor_cost_cents = 'Contractor cost cannot exceed the customer price (negative margin).';
  }
  if (failIfErrors(res, errors)) return;

  const deposit = Math.round(b.customer_price_cents * depositPct / 100);
  const info = db.prepare(
    `INSERT INTO quotes (job_request_id, estimate_id, customer_price_cents, contractor_cost_cents,
      deposit_cents, deposit_pct, valid_until)
     VALUES (?,?,?,?,?,?, datetime(CURRENT_TIMESTAMP,'+14 days'))`
  ).run(job.id, b.estimate_id || null, b.customer_price_cents, b.contractor_cost_cents, deposit, depositPct);
  res.status(201).json({
    ...db.prepare('SELECT * FROM quotes WHERE id = ?').get(info.lastInsertRowid),
    margin_cents: b.customer_price_cents - b.contractor_cost_cents,
    margin_note: `Platform spread ${fmt(b.customer_price_cents - b.contractor_cost_cents)} on ${fmt(b.customer_price_cents)}.`,
  });
}));

// ---- Admin: send the quote to the customer ----
router.post('/:id/send', authRequired, requireRole('admin'), ah(async (req, res) => {
  const q = db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Quote not found.' });
  if (q.status !== 'draft') return res.status(400).json({ error: 'Only draft quotes can be sent.' });
  db.prepare(`UPDATE quotes SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?`).run(q.id);
  db.prepare(`UPDATE job_requests SET status = 'quote_sent', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(q.job_request_id);
  touchInteraction(q.job_request_id, 'quote_sent', `quote #${q.id}`);
  res.json(db.prepare('SELECT * FROM quotes WHERE id = ?').get(q.id));
}));

// ---- List quotes for a job (owner customer or admin) ----
router.get('/', authRequired, ah(async (req, res) => {
  const { job_request_id } = req.query;
  if (!job_request_id) return res.status(400).json({ error: 'job_request_id is required.' });
  const job = db.prepare('SELECT * FROM job_requests WHERE id = ?').get(job_request_id);
  if (!job) return res.status(404).json({ error: 'Job request not found.' });
  if (!jobVisibleTo(req, job)) return res.status(403).json({ error: 'Not allowed.' });
  res.json(db.prepare('SELECT * FROM quotes WHERE job_request_id = ? ORDER BY id DESC').all(job.id));
}));

// ---- Read a quote (owner customer or admin) ----
router.get('/:id', authRequired, ah(async (req, res) => {
  const q = db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Quote not found.' });
  const job = db.prepare('SELECT * FROM job_requests WHERE id = ?').get(q.job_request_id);
  if (!jobVisibleTo(req, job)) return res.status(403).json({ error: 'Not allowed.' });
  res.json(q);
}));

// ---- Customer: accept / reject. Accepting spins up the project + deposit record. ----
router.post('/:id/respond', authRequired, ah(async (req, res) => {
  const q = db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Quote not found.' });
  const job = db.prepare('SELECT * FROM job_requests WHERE id = ?').get(q.job_request_id);
  if (!jobVisibleTo(req, job)) return res.status(403).json({ error: 'Not allowed.' });
  if (q.status !== 'sent') return res.status(400).json({ error: 'This quote is no longer awaiting a response.' });
  const accept = (req.body || {}).accept === true;

  if (!accept) {
    db.prepare(`UPDATE quotes SET status = 'rejected', responded_at = CURRENT_TIMESTAMP WHERE id = ?`).run(q.id);
    db.prepare(`UPDATE job_requests SET status = 'lost', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(job.id);
    touchInteraction(job.id, 'customer_reply', 'quote rejected');
    return res.json({ accepted: false });
  }

  const tx = db.transaction(() => {
    db.prepare(`UPDATE quotes SET status = 'accepted', responded_at = CURRENT_TIMESTAMP WHERE id = ?`).run(q.id);
    const p = db.prepare(
      `INSERT INTO projects (job_request_id, quote_id, customer_price_cents, contractor_cost_cents, stage)
       VALUES (?,?,?,?, 'assigned')`
    ).run(job.id, q.id, q.customer_price_cents, q.contractor_cost_cents);
    const names = MILESTONES[job.service_type] || GENERIC_MILESTONES;
    const ins = db.prepare('INSERT INTO milestones (project_id, title, sort_order) VALUES (?,?,?)');
    names.forEach((t, i) => ins.run(p.lastInsertRowid, t, i));
    // Bookkeeping: the deposit the platform collects (Stripe NOT integrated).
    db.prepare(
      `INSERT INTO payments (project_id, kind, amount_cents, status, provider, notes)
       VALUES (?,?,?,'recorded','manual',?)`
    ).run(p.lastInsertRowid, 'deposit', q.deposit_cents,
      `Deposit ${q.deposit_pct}% of ${fmt(q.customer_price_cents)} — recorded manually (no Stripe integration).`);
    db.prepare(`UPDATE job_requests SET status = 'deposit_paid', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(job.id);
    return p.lastInsertRowid;
  });
  const projectId = tx();
  touchInteraction(job.id, 'customer_reply', 'quote accepted');
  res.json({ accepted: true, project_id: projectId });
}));

module.exports = router;
