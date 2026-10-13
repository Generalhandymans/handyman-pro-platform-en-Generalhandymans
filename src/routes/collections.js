// Collections (finance): who owes us money, and polite reminders — never during a dispute, never twice in a
// few days, and only when the customer can actually pay. Money is still collected through the customer portal
// (Stripe); this screen only tells people it is waiting for them.
'use strict';
const express = require('express');
const db = require('../db');
const { ah, authRequired } = require('../middleware');
const { requireStaff } = require('../services/permissions');
const { auditLog } = require('../services/audit');
const { notify, shell } = require('../services/notify');
const events = require('../services/events');
const col = require('../services/collections');

const router = express.Router();
router.use(authRequired, requireStaff('finance'));

const money = (c) => '$' + (Number(c) / 100).toFixed(2);

async function undeliverable(email) {
  // Hard bounces and spam complaints: the address cannot (or must not) be mailed. A plain promotional
  // unsubscribe does NOT block a reminder about money the customer owes.
  const r = await db.prepare('SELECT reason FROM email_suppressions WHERE email = ?').get(String(email).toLowerCase());
  return !!(r && /^sendgrid:(bounce|dropped|spamreport)/.test(r.reason || ''));
}

async function loadItems(now = new Date()) {
  const projects = await db.prepare(
    `SELECT p.id AS project_id, p.customer_price_cents, p.stage, p.created_at, j.service_type, j.name AS job_name,
            j.email AS job_email, u.email AS user_email, u.name AS user_name, q.deposit_cents
     FROM projects p JOIN job_requests j ON j.id = p.job_request_id
     LEFT JOIN users u ON u.id = j.customer_id LEFT JOIN quotes q ON q.id = p.quote_id
     WHERE p.stage <> 'cancelled' ORDER BY p.id DESC LIMIT 2000`
  ).all();
  const pays = await db.prepare(`SELECT project_id, kind, COALESCE(SUM(amount_cents),0) AS s FROM payments WHERE status IN ('paid','recorded') GROUP BY project_id, kind`).all();
  const net = new Map(), hasDeposit = new Set();
  for (const r of pays) {
    const sign = r.kind === 'refund' ? -1 : (['deposit', 'milestone', 'final'].includes(r.kind) ? 1 : 0);
    net.set(r.project_id, (net.get(r.project_id) || 0) + sign * Number(r.s));
    if (r.kind === 'deposit' && Number(r.s) > 0) hasDeposit.add(r.project_id);
  }
  const signed = new Map((await db.prepare('SELECT project_id, signed_at FROM completion_sheets').all()).map(r => [r.project_id, r.signed_at]));
  const disputed = new Set((await db.prepare(`SELECT project_id FROM disputes WHERE status IN ('open','investigating')`).all()).map(r => r.project_id));
  const rem = new Map((await db.prepare('SELECT project_id, COUNT(*) AS n, MAX(created_at) AS last FROM collection_reminders GROUP BY project_id').all()).map(r => [r.project_id, r]));

  const items = [];
  for (const p of projects) {
    const paid = net.get(p.project_id) || 0;
    const balance = Number(p.customer_price_cents) - paid;
    if (balance < col.MIN_CENTS) continue;
    const r = rem.get(p.project_id);
    const base = {
      project_id: p.project_id, balance_cents: balance, has_deposit: hasDeposit.has(p.project_id), deposit_cents: Number(p.deposit_cents || 0),
      signed_at: signed.get(p.project_id) || null, open_dispute: disputed.has(p.project_id),
      last_reminder_at: r ? r.last : null, reminders: r ? Number(r.n) : 0,
    };
    const c = col.classify(base, now);
    items.push({
      ...base, ...c,
      customer_name: p.user_name || p.job_name, customer_email: p.user_email || p.job_email,
      service_type: p.service_type, price_cents: Number(p.customer_price_cents), paid_cents: paid, stage: p.stage,
      can_remind: col.canRemind(base, c, now),
    });
  }
  return items;
}

router.get('/', ah(async (req, res) => {
  const items = await loadItems();
  const status = ['deposit_unpaid', 'not_ready', 'in_dispute', 'due', 'overdue'].includes(req.query.status) ? req.query.status : null;
  const rows = status ? items.filter(i => i.status === status) : items;
  // most urgent first: overdue (longest first), then due, deposit, not ready, disputes
  const order = { overdue: 0, due: 1, deposit_unpaid: 2, not_ready: 3, in_dispute: 4 };
  rows.sort((a, b) => order[a.status] - order[b.status] || b.days_overdue - a.days_overdue || b.balance_cents - a.balance_cents);
  res.json({ items: rows, totals: col.summarize(items), terms_days: col.DUE_DAYS(), cooldown_days: col.COOLDOWN_DAYS() });
}));

async function sendReminder(item, byUserId) {
  const to = item.customer_email;
  if (!to) return { sent: false, reason: 'This customer has no email on file.' };
  if (await undeliverable(to)) return { sent: false, reason: 'That address bounced or marked our email as spam: do not mail it again.' };
  const isDeposit = item.status === 'deposit_unpaid';
  const amount = item.can_remind.amount_cents;
  const first = String(item.customer_name || '').split(' ')[0] || 'there';
  const portal = `${process.env.PUBLIC_URL || 'http://localhost:3000'}/customer.html`;
  const lead = isDeposit
    ? `Hi ${first}, your ${item.service_type} project is booked, but we have not received the deposit yet. You can complete it securely from your portal:`
    : `Hi ${first}, your ${item.service_type} project was signed off and the remaining balance is ready to pay. You can pay securely from your portal:`;
  const result = await notify({
    to,
    subject: isDeposit ? `Your deposit for project #${item.project_id} is still pending` : `Your final balance for project #${item.project_id}: ${money(amount)}`,
    html: shell(isDeposit ? 'Deposit pending' : 'Balance ready to pay', lead, [
      ['Project', `#${item.project_id} — ${item.service_type}`],
      [isDeposit ? 'Deposit' : 'Balance due', money(amount)],
      ['Pay here', portal],
      ['If something is wrong', 'If the work is not as agreed, report a problem in your portal: payments pause while we look into it. Or just reply to this email.'],
    ]),
  });
  await db.prepare('INSERT INTO collection_reminders (project_id, sent_by, to_email, kind, amount_cents, status) VALUES (?,?,?,?,?,?)')
    .run(item.project_id, byUserId, to, item.status, amount, result.ok ? 'sent' : 'failed');
  await events.record('project', item.project_id, 'collection.reminder', { actorId: byUserId, data: { kind: item.status, amount_cents: amount, ok: !!result.ok } });
  return result.ok ? { sent: true, amount_cents: amount } : { sent: false, reason: 'The email could not be sent. Check the email provider.' };
}

router.post('/:projectId/remind', ah(async (req, res) => {
  const item = (await loadItems()).find(i => i.project_id === Number(req.params.projectId));
  if (!item) return res.status(404).json({ error: 'Nothing is owed on that project (or it does not exist).' });
  if (!item.can_remind.ok) return res.status(409).json({ error: item.can_remind.reason, status: item.status });
  const out = await sendReminder(item, req.user.id);
  if (!out.sent) return res.status(502).json({ error: out.reason });
  await auditLog(req.user.id, 'collections.reminder', 'projects', item.project_id, `${item.status} ${money(out.amount_cents)}`);
  res.json({ ...out, status: item.status });
}));

// Every customer who is OVERDUE and eligible (one rule for single and bulk). Deposits and "due" are never bulk-sent.
router.post('/remind-overdue', ah(async (req, res) => {
  const items = (await loadItems()).filter(i => i.status === 'overdue');
  let sent = 0; const skipped = [];
  for (const it of items) {
    if (!it.can_remind.ok) { skipped.push({ project_id: it.project_id, reason: it.can_remind.reason }); continue; }
    const out = await sendReminder(it, req.user.id);
    if (out.sent) sent++; else skipped.push({ project_id: it.project_id, reason: out.reason });
  }
  await auditLog(req.user.id, 'collections.bulk_reminder', 'projects', null, `${sent} sent, ${skipped.length} skipped`);
  res.json({ sent, skipped, overdue: items.length });
}));

module.exports = router;
