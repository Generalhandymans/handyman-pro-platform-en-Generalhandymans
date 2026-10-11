// Dispute helpers: the payment hold and the refund engine.
'use strict';
const db = require('../db');

const OPEN = `('open','investigating')`;

async function openDisputeFor(projectId) {
  return db.prepare(`SELECT id FROM disputes WHERE project_id = ? AND status IN ${OPEN}`).get(projectId);
}

// What the customer has paid on the project, net of refunds.
async function netPaidCents(projectId) {
  const rows = await db.prepare(
    `SELECT kind, COALESCE(SUM(amount_cents),0) AS s FROM payments
     WHERE project_id = ? AND status IN ('paid','recorded') GROUP BY kind`
  ).all(projectId);
  const by = Object.fromEntries(rows.map(r => [r.kind, Number(r.s)]));
  return (by.deposit || 0) + (by.milestone || 0) + (by.final || 0) - (by.refund || 0);
}

// Refund rows already created FOR THIS dispute (makes a retry after a partial failure safe).
async function refundedForDispute(projectId, disputeId) {
  const r = await db.prepare(
    `SELECT COALESCE(SUM(amount_cents),0) AS s FROM payments
     WHERE project_id = ? AND kind = 'refund' AND status IN ('paid','recorded') AND notes LIKE ?`
  ).get(projectId, `Dispute #${disputeId} %`);
  return Number(r.s);
}

// Refunds `amountCents`: Stripe charges first (newest first, each up to what is refundable),
// and whatever remains is recorded as a MANUAL refund for the team to send outside the app.
async function executeRefund({ projectId, amountCents, disputeId }) {
  const stripeSvc = require('./stripe');
  const note = `Dispute #${disputeId} — refund`;
  let remaining = amountCents, viaStripe = 0, manual = 0;
  if (remaining > 0 && stripeSvc.isEnabled()) {
    const pays = await db.prepare(
      `SELECT * FROM payments WHERE project_id = ? AND provider = 'stripe' AND status = 'paid'
       AND kind IN ('final','deposit','milestone') ORDER BY id DESC`
    ).all(projectId);
    for (const pay of pays) {
      if (remaining < 1) break;
      const r = await stripeSvc.refundPayment({ payment: pay, amountCents: remaining, cap: true, note });
      if (!r) continue;
      remaining -= r.amount_cents; viaStripe += r.amount_cents;
    }
  }
  if (remaining > 0) {
    await db.prepare(
      `INSERT INTO payments (project_id, kind, amount_cents, status, provider, notes) VALUES (?,?,?,'recorded','manual',?)`
    ).run(projectId, 'refund', remaining, `${note} (manual: send the money outside the app)`);
    manual = remaining;
  }
  return { via_stripe_cents: viaStripe, manual_cents: manual };
}

module.exports = { openDisputeFor, netPaidCents, refundedForDispute, executeRefund };
