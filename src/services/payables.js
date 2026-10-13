// Contractor payables: what the platform owes a contractor for a completed job.
// A payable is created when a project completes; an admin approves and pays it
// (the platform records HOW it was paid — it does not move the money itself).
'use strict';
const db = require('../db');

const TERMS_DAYS = () => Number(process.env.PAYOUT_TERMS_DAYS) || 7;

// What the customer still owes on a project: price - (deposit + milestone + final) + refunds.
async function customerBalanceCents(projectId) {
  const p = await db.prepare('SELECT customer_price_cents FROM projects WHERE id = ?').get(projectId);
  if (!p) return 0;
  const rows = await db.prepare(
    `SELECT kind, COALESCE(SUM(amount_cents),0) AS s FROM payments
     WHERE project_id = ? AND status IN ('paid','recorded') GROUP BY kind`
  ).all(projectId);
  const by = Object.fromEntries(rows.map(r => [r.kind, Number(r.s)]));
  const net = (by.deposit || 0) + (by.milestone || 0) + (by.final || 0) - (by.refund || 0);
  return Math.max(0, p.customer_price_cents - net);
}

// Idempotent: returns the existing payable if there is one. No contractor -> null.
async function ensurePayable(project) {
  if (!project || project.contractor_id == null || !(project.contractor_cost_cents > 0)) return null;
  // Company technicians are paid through payroll (outside this app): no per-job payable. Their
  // contractor_cost_cents stays as the internal labor cost used for margin reporting.
  const who = await db.prepare('SELECT provider_type FROM contractors WHERE id = ?').get(project.contractor_id);
  if (who && who.provider_type === 'employee') return null;
  const existing = await db.prepare('SELECT * FROM contractor_payables WHERE project_id = ?').get(project.id);
  if (existing) return existing;
  const due = new Date(Date.now() + TERMS_DAYS() * 86400000).toISOString();
  try {
    await db.prepare(
      `INSERT INTO contractor_payables (project_id, contractor_id, payable_cents, status, due_at)
       VALUES (?,?,?,'pending',?)`
    ).run(project.id, project.contractor_id, project.contractor_cost_cents, due);
  } catch (e) { /* UNIQUE(project_id): a concurrent call created it first */ }
  return db.prepare('SELECT * FROM contractor_payables WHERE project_id = ?').get(project.id);
}

module.exports = { customerBalanceCents, ensurePayable, TERMS_DAYS };
