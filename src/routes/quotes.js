// Quotes: platform prices the job (customer price vs contractor cost = margin).
const express = require('express');
const db = require('../db');
const { ah, authRequired, requireRole, isInt, failIfErrors } = require('../middleware');
const { touchInteraction } = require('../services/crm');
const { notify, shell } = require('../services/notify');
const { auditLog } = require('../services/audit');

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
  roofing: ['Inspection and protection', 'Repair / replacement', 'Cleanup and final check'],
  hvac: ['Diagnostic', 'Repair / installation', 'Testing and calibration'],
  landscaping: ['Site prep', 'Main work', 'Cleanup and walkthrough'],
  fencing: ['Layout and post setting', 'Panel / picket installation', 'Gates and cleanup'],
  concrete: ['Forming and prep', 'Pour and finish', 'Cure check and cleanup'],
  appliance: ['Delivery and prep', 'Installation and hookup', 'Testing and haul-away'],
  garage_door: ['Inspection and parts', 'Repair / installation', 'Balance test and cleanup'],
  pressure_washing: ['Prep and protection', 'Washing', 'Rinse and final check'],
  general: ['Assessment and prep', 'Main work', 'Cleanup and client review'],
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
  auditLog(req.user.id, 'quote.created', 'quotes', info.lastInsertRowid,
    `Job #${job.id}: customer ${fmt(b.customer_price_cents)}, contractor ${fmt(b.contractor_cost_cents)}, deposit ${depositPct}%`);
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
  auditLog(req.user.id, 'quote.sent', 'quotes', q.id, `Sent to customer, ${fmt(q.customer_price_cents)}`);

  // Notify the customer by email.
  const job = db.prepare('SELECT * FROM job_requests WHERE id = ?').get(q.job_request_id);
  const to = job.customer_id
    ? (db.prepare('SELECT email, name FROM users WHERE id = ?').get(job.customer_id) || {}).email
    : job.email;
  if (to) {
    notify({
      to,
      subject: `Your General Handyman Solutions quote is ready — ${fmt(q.customer_price_cents)}`,
      html: shell('Your quote is ready', 'We prepared a fixed quote for your project. Review and accept it from your portal:', [
        ['Project', `#${job.id} — ${job.service_type}`],
        ['Quoted price', fmt(q.customer_price_cents)],
        ['Deposit to start', `${fmt(q.deposit_cents)} (${q.deposit_pct}%)`],
        ['Valid until', String(q.valid_until || '').slice(0, 10)],
      ]),
    }).catch(() => {});
  }
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

// ---- Customer: accept / reject. Accepting requires Terms acceptance and
// spins up the project + deposit record. ----
router.post('/:id/respond', authRequired, ah(async (req, res) => {
  const q = db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Quote not found.' });
  const job = db.prepare('SELECT * FROM job_requests WHERE id = ?').get(q.job_request_id);
  if (!jobVisibleTo(req, job)) return res.status(403).json({ error: 'Not allowed.' });
  const accept = (req.body || {}).accept === true;
  const termsAccepted = (req.body || {}).terms_accepted === true;

  if (!accept) {
    if (q.status !== 'sent') return res.status(400).json({ error: 'This quote is no longer awaiting a response.' });
    db.prepare(`UPDATE quotes SET status = 'rejected', responded_at = CURRENT_TIMESTAMP WHERE id = ?`).run(q.id);
    db.prepare(`UPDATE job_requests SET status = 'lost', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(job.id);
    touchInteraction(job.id, 'customer_reply', 'quote rejected');
    return res.json({ accepted: false });
  }

  // Legal gate: accepting the price + paying the deposit requires explicit
  // acceptance of the Terms of Service.
  if (!termsAccepted) {
    return res.status(400).json({ error: 'You must accept the Terms of Service to accept this quote and pay the deposit.' });
  }

  const { CLIENT_TERMS_VERSION, recordAcceptance } = require('../services/terms');
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || null;

  let projectId;
  try {
    const tx = db.transaction(() => {
      // Re-check inside the transaction: prevents double-accept races.
      const fresh = db.prepare('SELECT status FROM quotes WHERE id = ?').get(q.id);
      if (fresh.status !== 'sent') throw Object.assign(new Error('This quote is no longer awaiting a response.'), { statusCode: 400 });
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
      // Legal proof: who accepted which terms version, when.
      recordAcceptance({ userId: req.user.id, kind: 'client_quote', referenceId: q.id, version: CLIENT_TERMS_VERSION, ip });
      return p.lastInsertRowid;
    });
    projectId = tx();
  } catch (e) {
    return res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Something went wrong on our end. Please try again.' });
  }
  touchInteraction(job.id, 'customer_reply', 'quote accepted');

  // Notify admins: a customer accepted — time to assign a contractor.
  const admins = db.prepare("SELECT email FROM users WHERE role = 'admin'").all();
  for (const a of admins) {
    notify({
      to: a.email,
      subject: `Quote accepted — project #${projectId} needs a contractor`,
      html: shell('Quote accepted', `${job.name} accepted the quote. Assign a contractor to start:`, [
        ['Project', `#${projectId} — ${job.service_type}`],
        ['Customer', `${job.name} (${job.phone})`],
        ['Quoted price', fmt(q.customer_price_cents)],
        ['Contractor budget', fmt(q.contractor_cost_cents)],
      ]),
    }).catch(() => {});
  }
  res.json({ accepted: true, project_id: projectId });
}));

module.exports = router;
