// Collections: who owes the business money, since when, and may we remind them now?
// classify()/canRemind() are PURE (rows in, decisions out) so the rules are testable without a database.
//
// Statuses:
//   deposit_unpaid  the quote was accepted but the deposit never arrived (typically an abandoned card payment)
//   not_ready       a balance exists but the final payment is not open yet (work not signed off)
//   in_dispute      an open dispute holds payments: NEVER remind
//   due             signed off, still inside the payment terms
//   overdue         signed off and past the terms
// Reminders go only to due / overdue / deposit_unpaid, with a cool-down so nobody is pestered.
'use strict';
const { toDate } = require('./kpis');

const DAY = 86400000;
const DUE_DAYS = () => Number(process.env.COLLECTIONS_DUE_DAYS) || 7;
const COOLDOWN_DAYS = () => Number(process.env.COLLECTIONS_REMINDER_COOLDOWN_DAYS) || 3;
const MIN_CENTS = 100;

// item: { project_id, balance_cents, has_deposit, deposit_cents, signed_at, open_dispute, last_reminder_at, reminders, created_at }
function classify(item, now = new Date(), dueDays = DUE_DAYS()) {
  if (item.open_dispute) return { status: 'in_dispute', due_at: null, days_overdue: 0 };
  const signed = toDate(item.signed_at);
  if (signed) {
    const due = new Date(signed.getTime() + dueDays * DAY);
    const late = Math.floor((now - due) / DAY);
    return now > due ? { status: 'overdue', due_at: due.toISOString(), days_overdue: Math.max(1, late) } : { status: 'due', due_at: due.toISOString(), days_overdue: 0 };
  }
  if (!item.has_deposit && item.deposit_cents > 0) return { status: 'deposit_unpaid', due_at: null, days_overdue: 0 };
  return { status: 'not_ready', due_at: null, days_overdue: 0 };
}

// { ok:true } or { ok:false, reason } — the SAME rule the single and the bulk send use.
function canRemind(item, c, now = new Date(), cooldownDays = COOLDOWN_DAYS()) {
  if (!['due', 'overdue', 'deposit_unpaid'].includes(c.status)) {
    return { ok: false, reason: c.status === 'in_dispute' ? 'There is an open dispute on this project.' : 'The final payment is not open yet (the work is not signed off).' };
  }
  const amount = c.status === 'deposit_unpaid' ? item.deposit_cents : item.balance_cents;
  if (!(amount >= MIN_CENTS)) return { ok: false, reason: 'There is nothing to collect.' };
  const last = toDate(item.last_reminder_at);
  if (last && now - last < cooldownDays * DAY) {
    const next = new Date(last.getTime() + cooldownDays * DAY);
    return { ok: false, reason: `A reminder was already sent recently. The next one can go out on ${next.toISOString().slice(0, 10)}.` };
  }
  return { ok: true, amount_cents: amount };
}

// Totals by status for the screen header.
function summarize(rows) {
  const out = { owed_cents: 0, overdue_cents: 0, due_cents: 0, in_dispute_cents: 0, not_ready_cents: 0, deposit_unpaid_cents: 0, count: rows.length };
  for (const r of rows) {
    const amt = r.status === 'deposit_unpaid' ? r.deposit_cents : r.balance_cents;
    out.owed_cents += amt;
    out[r.status + '_cents'] = (out[r.status + '_cents'] || 0) + amt;
  }
  return out;
}

module.exports = { classify, canRemind, summarize, DUE_DAYS, COOLDOWN_DAYS, MIN_CENTS };
