// KPI engine for the admin dashboard. PURE: takes plain rows, returns numbers,
// so every definition is testable without a database. Dates may be SQLite text
// ('YYYY-MM-DD HH:MM:SS', UTC) or PostgreSQL Date objects.
'use strict';
const sched = require('./schedule');

const ACTIVE = new Set(['assigned', 'scheduled', 'in_progress', 'review']);
const OK_PAY = new Set(['paid', 'recorded']);

function toDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  const s = String(v).replace(' ', 'T');
  const d = new Date(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z');
  return isNaN(d) ? null : d;
}
const hoursBetween = (a, b) => {
  const x = toDate(a), y = toDate(b);
  return x && y && y >= x ? (y - x) / 3600000 : null;
};
function median(xs) {
  const a = xs.filter(v => v != null).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);
const speed = (xs) => ({ median_hours: round1(median(xs)), n: xs.filter(v => v != null).length });

// Net cents the customer has paid on a project: deposit + milestone + final - refunds.
function netPaidByProject(payments) {
  const m = new Map();
  for (const p of payments) {
    if (!OK_PAY.has(p.status)) continue;
    const sign = p.kind === 'refund' ? -1 : (['deposit', 'milestone', 'final'].includes(p.kind) ? 1 : 0);
    m.set(p.project_id, (m.get(p.project_id) || 0) + sign * Number(p.amount_cents));
  }
  return m;
}

function computeKpis(d, opts = {}) {
  const now = opts.now || new Date();
  const days = opts.days || 30;
  const from = new Date(now.getTime() - days * 86400000);
  const inWin = (v) => { const t = toDate(v); return !!t && t >= from && t <= now; };

  const quotesByJob = new Map();
  for (const q of d.quotes) { (quotesByJob.get(q.job_request_id) || quotesByJob.set(q.job_request_id, []).get(q.job_request_id)).push(q); }
  const projByJob = new Map();
  for (const p of d.projects) if (!projByJob.has(p.job_request_id)) projByJob.set(p.job_request_id, p);
  // ---- business events: exact completion dates and the moment a payment was CONFIRMED ----
  const evData = (e) => { if (e.data == null) return null; if (typeof e.data === 'object') return e.data; try { return JSON.parse(e.data); } catch (x) { return null; } };
  const completedAt = new Map();   // project id -> time of the LAST move to 'completed'
  const paidAt = new Map();        // payment id -> time Stripe/the team confirmed it
  for (const e of (d.events || [])) {
    const t = toDate(e.created_at); if (!t) continue;
    if (e.type === 'project.stage' && e.entity === 'project') {
      const x = evData(e);
      if (x && x.to === 'completed' && (!completedAt.has(e.entity_id) || t > completedAt.get(e.entity_id))) completedAt.set(e.entity_id, t);
    } else if (e.type === 'payment.paid' && e.entity === 'payment') paidAt.set(e.entity_id, t);
  }

  const depositByProject = new Map();
  for (const p of d.payments) {
    if (p.kind === 'deposit' && OK_PAY.has(p.status)) {
      const when = paidAt.get(p.id) || toDate(p.created_at);
      const prev = depositByProject.get(p.project_id);
      if (!prev || when < prev.when) depositByProject.set(p.project_id, { ...p, when });
    }
  }
  const sheetByProject = new Map(d.sheets.map(s => [s.project_id, s]));


  // ---------- funnel + speed: cohort = requests created in the window ----------
  const cohort = d.jobs.filter(j => inWin(j.created_at));
  const f = { requests: cohort.length, quoted: 0, accepted: 0, deposit_paid: 0, completed: 0 };
  const sp = { request_to_quote: [], quote_to_accept: [], accept_to_deposit: [], project_to_signoff: [], start_to_complete: [] };
  const bySource = new Map();
  for (const j of cohort) {
    const qs = (quotesByJob.get(j.id) || []).filter(q => q.sent_at);
    const acc = (quotesByJob.get(j.id) || []).find(q => q.status === 'accepted');
    const proj = projByJob.get(j.id);
    const dep = proj && depositByProject.get(proj.id);
    if (qs.length) {
      f.quoted++;
      const first = qs.map(q => toDate(q.sent_at)).sort((a, b) => a - b)[0];
      sp.request_to_quote.push(hoursBetween(j.created_at, first));
    }
    if (acc) {
      f.accepted++;
      sp.quote_to_accept.push(hoursBetween(acc.sent_at, acc.responded_at));
    }
    if (dep) { f.deposit_paid++; sp.accept_to_deposit.push(hoursBetween(proj.created_at, dep.when)); }
    if (proj && proj.stage === 'completed') f.completed++;
    if (proj && sheetByProject.has(proj.id)) sp.project_to_signoff.push(hoursBetween(proj.created_at, sheetByProject.get(proj.id).signed_at));
    const src = j.source || 'unknown';
    const s = bySource.get(src) || { source: src, requests: 0, accepted: 0 };
    s.requests++; if (acc) s.accepted++;
    bySource.set(src, s);
  }
  const funnel = {
    ...f,
    rates: {
      request_to_quote: pct(f.quoted, f.requests), quote_to_accept: pct(f.accepted, f.quoted),
      accept_to_deposit: pct(f.deposit_paid, f.accepted), deposit_to_completed: pct(f.completed, f.deposit_paid),
      overall: pct(f.completed, f.requests),
    },
    note: 'Recent requests are still moving through the funnel, so the later rates rise as the cohort matures.',
  };
  const sources = [...bySource.values()].map(s => ({ ...s, accept_rate: pct(s.accepted, s.requests) })).sort((a, b) => b.requests - a.requests);

  // ---------- money ----------
  const winPays = d.payments.filter(p => OK_PAY.has(p.status) && inWin(p.created_at));
  const sumKind = (k) => winPays.filter(p => p.kind === k).reduce((a, p) => a + Number(p.amount_cents), 0);
  const refunds = sumKind('refund');
  const collected = sumKind('deposit') + sumKind('milestone') + sumKind('final') - refunds;
  const accQuotes = d.quotes.filter(q => q.status === 'accepted' && inWin(q.responded_at));
  const booked = accQuotes.reduce((a, q) => a + Number(q.customer_price_cents), 0);
  const winProjects = d.projects.filter(p => inWin(p.created_at) && p.stage !== 'cancelled');
  const sumP = (rows, k) => rows.reduce((a, p) => a + Number(p[k] || 0), 0);
  const doneProjects = winProjects.filter(p => p.stage === 'completed');
  // By the EXACT completion date (needs the events log): what finished in the window, whenever it started.
  const doneByDate = d.projects.filter(p => p.stage === 'completed' && completedAt.has(p.id) && inWin(completedAt.get(p.id)));
  for (const p of doneByDate) sp.start_to_complete.push(hoursBetween(p.created_at, completedAt.get(p.id)));
  const dRev = sumP(doneByDate, 'customer_price_cents'), dCost = sumP(doneByDate, 'contractor_cost_cents');
  const money = {
    collected_cents: collected, refunds_cents: refunds,
    by_kind: { deposit: sumKind('deposit'), milestone: sumKind('milestone'), final: sumKind('final') },
    quotes_accepted: accQuotes.length, booked_cents: booked,
    avg_ticket_cents: accQuotes.length ? Math.round(booked / accQuotes.length) : null,
    booked_margin_pct: pct(sumP(winProjects, 'customer_price_cents') - sumP(winProjects, 'contractor_cost_cents'), sumP(winProjects, 'customer_price_cents')),
    completed_margin_cents: sumP(doneProjects, 'customer_price_cents') - sumP(doneProjects, 'contractor_cost_cents'),
    completed_margin_pct: pct(sumP(doneProjects, 'customer_price_cents') - sumP(doneProjects, 'contractor_cost_cents'), sumP(doneProjects, 'customer_price_cents')),
    completed_by_date: { count: doneByDate.length, revenue_cents: dRev, margin_cents: dRev - dCost, margin_pct: pct(dRev - dCost, dRev) },
    note: '"Margin (completed)" uses projects STARTED in the window; "completed by date" uses the exact completion date from the events log (projects completed before the log existed are not counted). Collected = deposits + milestones + final − refunds, by payment date.',
  };

  // Speed medians are summarized HERE, after every bucket (incl. start_to_complete from the events log) is filled.
  const speedOut = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, speed(v)]));

  // ---------- receivables (customers who still owe us) ----------
  const net = netPaidByProject(d.payments);
  const ar = { total_cents: 0, count: 0, d0_30: 0, d31_60: 0, d61_plus: 0 };
  for (const p of d.projects) {
    if (p.stage === 'cancelled') continue;
    const bal = Number(p.customer_price_cents) - (net.get(p.id) || 0);
    if (bal < 100) continue;
    const age = Math.floor((now - toDate(p.created_at)) / 86400000);
    ar.total_cents += bal; ar.count++;
    if (age <= 30) ar.d0_30 += bal; else if (age <= 60) ar.d31_60 += bal; else ar.d61_plus += bal;
  }

  // ---------- payables (we owe contractors) ----------
  const open = d.payables.filter(p => ['pending', 'approved'].includes(p.status));
  const payables = {
    owed_cents: open.reduce((a, p) => a + Number(p.payable_cents), 0),
    overdue_cents: open.filter(p => toDate(p.due_at) && toDate(p.due_at) < now).reduce((a, p) => a + Number(p.payable_cents), 0),
    paid_in_window_cents: d.payables.filter(p => p.status === 'paid' && inWin(p.paid_at)).reduce((a, p) => a + Number(p.payable_cents), 0),
  };

  // ---------- quality ----------
  const rv = d.reviews.filter(r => inWin(r.created_at));
  const mc = d.milestoneCounts || {};
  const doneCust = new Map();
  const jobById = new Map(d.jobs.map(j => [j.id, j]));
  for (const p of d.projects) {
    if (p.stage !== 'completed') continue;
    const cid = (jobById.get(p.job_request_id) || {}).customer_id;
    if (cid) doneCust.set(cid, (doneCust.get(cid) || 0) + 1);
  }
  const quality = {
    reviews: rv.length,
    avg_rating: rv.length ? round1(rv.reduce((a, r) => a + Number(r.rating), 0) / rv.length) : null,
    milestone_rejection_pct: pct(mc.rejected || 0, (mc.approved || 0) + (mc.rejected || 0)),
    customers_with_completed: doneCust.size,
    repeat_customers: [...doneCust.values()].filter(n => n >= 2).length,
    repeat_rate_pct: pct([...doneCust.values()].filter(n => n >= 2).length, doneCust.size),
    disputes_opened: (d.disputes || []).filter(x => inWin(x.created_at)).length,
    disputes_open_now: (d.disputes || []).filter(x => ['open', 'investigating'].includes(x.status)).length,
    dispute_rate_pct: pct((d.disputes || []).filter(x => inWin(x.created_at)).length, winProjects.length),
    refunded_by_disputes_cents: (d.disputes || []).filter(x => x.status === 'resolved' && inWin(x.resolved_at)).reduce((a, x) => a + Number(x.refund_cents || 0), 0),
  };

  // ---------- capacity ----------
  const activeRows = d.projects.filter(p => ACTIVE.has(p.stage));
  const capacity = {
    active_projects: activeRows.length,
    unscheduled: activeRows.filter(p => !p.scheduled_start).length,
    double_booked: activeRows.filter(p => sched.conflictsFor(p, activeRows).length).length,
  };

  // ---------- visits: no-shows and reschedules (logged by contractors/dispatch, and automatically on a moved date) ----------
  const ve = (d.visits || []).filter(v => inWin(v.created_at));
  const cnt = (o) => ve.filter(v => v.outcome === o).length;
  const visits = {
    logged: ve.length,
    completed: cnt('completed'),
    customer_no_show: cnt('customer_no_show'),
    contractor_no_show: cnt('contractor_no_show'),
    rescheduled: cnt('rescheduled'),
    // share of ATTENDED-or-missed visits that were missed (reschedules are tracked separately)
    no_show_rate_pct: pct(cnt('customer_no_show') + cnt('contractor_no_show'), cnt('completed') + cnt('customer_no_show') + cnt('contractor_no_show')),
    note: 'Only visits that someone logged are counted; a low "logged" number means the team is not recording outcomes yet.',
  };

  // ---------- company technicians vs independent contractors ----------
  const typeOf = new Map((d.contractors || []).map(c => [c.id, c.provider_type || 'contractor']));
  const providers = { employee: { active: 0, completed: 0, revenue_cents: 0, margin_cents: 0 }, contractor: { active: 0, completed: 0, revenue_cents: 0, margin_cents: 0 }, unassigned: { active: 0 } };
  for (const p of d.projects) {
    if (!ACTIVE.has(p.stage)) continue;
    if (p.contractor_id == null) providers.unassigned.active++;
    else providers[typeOf.get(p.contractor_id) === 'employee' ? 'employee' : 'contractor'].active++;
  }
  for (const p of doneByDate) {
    if (p.contractor_id == null) continue;
    const g = providers[typeOf.get(p.contractor_id) === 'employee' ? 'employee' : 'contractor'];
    g.completed++; g.revenue_cents += Number(p.customer_price_cents); g.margin_cents += Number(p.customer_price_cents) - Number(p.contractor_cost_cents || 0);
  }
  for (const g of [providers.employee, providers.contractor]) g.margin_pct = pct(g.margin_cents, g.revenue_cents);

  return {
    window: { days, from: from.toISOString(), to: now.toISOString() },
    funnel, speed: speedOut, sources, money, receivables: ar, payables, quality, capacity, visits, providers,
    not_tracked: [
      'NPS (only a 1–5 review rating exists)',
      'Customer acquisition cost (marketing spend is not stored)', 'Contractor utilization (no availability data)',
    ],
  };
}

module.exports = { computeKpis, toDate, median, netPaidByProject };
