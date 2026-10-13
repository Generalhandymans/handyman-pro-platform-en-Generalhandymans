// Reports: 100% computed from the database. No hardcoded numbers anywhere.
// Three views: client side, contractor side, consolidated business.
const express = require('express');
const { requireStaff, can } = require('../services/permissions');
const db = require('../db');
const { ah, authRequired, requireRole } = require('../middleware');
const crm = require('../services/crm');

const router = express.Router();
router.use(authRequired, requireStaff('finance'));

// ---- Consolidated overview KPIs ----
// ---- Business KPIs (funnel, speed, money, receivables, payables, quality, capacity) ----
// Definitions live in services/kpis.js. ?days=30 (7..730).
router.get('/kpis', ah(async (req, res) => {
  const n = Number(req.query.days);
  const days = Number.isInteger(n) && n >= 7 && n <= 730 ? n : 30;
  const LIM = 20000;
  const [jobs, quotes, projects, payments, sheets, payables, reviews, ms, disputes, visits, events, contractors] = await Promise.all([
    db.prepare(`SELECT id, customer_id, source, created_at FROM job_requests ORDER BY id DESC LIMIT ${LIM}`).all(),
    db.prepare(`SELECT id, job_request_id, status, customer_price_cents, sent_at, responded_at FROM quotes ORDER BY id DESC LIMIT ${LIM}`).all(),
    db.prepare(`SELECT id, job_request_id, contractor_id, stage, customer_price_cents, contractor_cost_cents, created_at, scheduled_start, scheduled_end FROM projects ORDER BY id DESC LIMIT ${LIM}`).all(),
    db.prepare(`SELECT id, project_id, kind, amount_cents, status, created_at FROM payments ORDER BY id DESC LIMIT ${LIM}`).all(),
    db.prepare(`SELECT project_id, signed_at FROM completion_sheets`).all(),
    db.prepare(`SELECT status, payable_cents, due_at, paid_at FROM contractor_payables`).all(),
    db.prepare(`SELECT rating, created_at FROM reviews`).all(),
    db.prepare(`SELECT customer_approval AS k, COUNT(*) AS c FROM milestones GROUP BY customer_approval`).all(),
    db.prepare(`SELECT status, refund_cents, created_at, resolved_at FROM disputes`).all(),
    db.prepare(`SELECT outcome, created_at FROM visit_events`).all(),
    db.prepare(`SELECT entity, entity_id, type, data, created_at FROM events WHERE type IN ('project.stage','payment.paid') ORDER BY id DESC LIMIT ${LIM}`).all(),
    db.prepare(`SELECT id, provider_type FROM contractors`).all(),
  ]);
  const milestoneCounts = Object.fromEntries(ms.map(r => [r.k, Number(r.c)]));
  res.json(require('../services/kpis').computeKpis(
    { jobs, quotes, projects, payments, sheets, payables, reviews, milestoneCounts, disputes, visits, events, contractors }, { days }));
}));

router.get('/overview', ah(async (req, res) => {
  // Each metric is awaited; a missing row or NULL aggregate becomes 0.
  const g = async (sql, key) => { const row = await db.prepare(sql).get(); return Number(row && row[key]) || 0; };
  const jobs = await g(`SELECT COUNT(*) c FROM job_requests`, 'c');
  const quotesSent = await g(`SELECT COUNT(*) c FROM quotes WHERE status IN ('sent','accepted')`, 'c');
  const quotesAccepted = await g(`SELECT COUNT(*) c FROM quotes WHERE status = 'accepted'`, 'c');
  const active = await g(`SELECT COUNT(*) c FROM projects WHERE stage IN ('assigned','scheduled','in_progress','review')`, 'c');
  const done = await g(`SELECT COUNT(*) c FROM projects WHERE stage = 'completed'`, 'c');
  const revenue = await g(`SELECT COALESCE(SUM(customer_price_cents),0) s FROM projects WHERE stage = 'completed'`, 's');
  const cost = await g(`SELECT COALESCE(SUM(contractor_cost_cents),0) s FROM projects WHERE stage = 'completed'`, 's');
  const contractors = await g(`SELECT COUNT(*) c FROM contractors WHERE status = 'active'`, 'c');
  const applicants = await g(`SELECT COUNT(*) c FROM contractors WHERE status = 'pending'`, 'c');
  const avgRating = await g(`SELECT COALESCE(AVG(rating),0) r FROM reviews`, 'r');
  const avgTicket = await g(`SELECT COALESCE(AVG(customer_price_cents),0) a FROM projects WHERE stage = 'completed'`, 'a');
  res.json({
    jobs, quotes_sent: quotesSent, quotes_accepted: quotesAccepted,
    acceptance_rate: quotesSent ? Math.round(quotesAccepted / quotesSent * 100) : 0,
    projects_active: active, projects_completed: done,
    revenue_cents: revenue, cost_cents: cost,
    gross_margin_pct: revenue ? Math.round((revenue - cost) / revenue * 100) : 0,
    avg_ticket_cents: Math.round(avgTicket),
    contractors_active: contractors, contractors_pending: applicants,
    avg_rating: Math.round(avgRating * 10) / 10,
  });
}));

// ---- Client funnel: lead -> quote -> project -> review -> referral ----
router.get('/funnel', ah(async (req, res) => {
  const stages = await db.prepare(
    `SELECT status, COUNT(*) AS count FROM job_requests GROUP BY status`
  ).all();
  const order = ['new', 'ai_analyzed', 'quote_sent', 'deposit_paid', 'assigned', 'scheduled', 'in_progress', 'review', 'completed', 'lost', 'cancelled'];
  const byStatus = Object.fromEntries(stages.map(s => [s.status, s.count]));
  const funnel = order.filter(s => byStatus[s]).map(s => ({ stage: s, count: byStatus[s] }));
  const first = funnel.length ? funnel[0].count : 0;
  const reviews = Number((await db.prepare(`SELECT COUNT(*) c FROM reviews`).get()).c) || 0;
  const referrals = Number((await db.prepare(`SELECT COUNT(*) c FROM referrals`).get()).c) || 0;
  res.json({
    client_funnel: funnel.map(f => ({ ...f, pct_of_top: first ? Math.round(f.count / first * 100) : 0 })),
    post_project: { reviews, referrals_issued: referrals },
  });
}));

// ---- Contractor funnel: applicant -> verification -> active -> performance ----
router.get('/contractor-funnel', ah(async (req, res) => {
  const rows = await db.prepare('SELECT * FROM contractors').all();
  const by = {};
  for (const c of rows) {
    const lc = crm.contractorLifecycle(c);
    by[lc] = (by[lc] || 0) + 1;
  }
  res.json({ contractor_funnel: by, total: rows.length });
}));

// ---- Projected (quote) vs actual (project) margins ----
router.get('/margins', ah(async (req, res) => {
  const rows = await db.prepare(
    `SELECT p.id, p.stage, j.service_type,
            q.customer_price_cents AS q_price, q.contractor_cost_cents AS q_cost,
            p.customer_price_cents AS p_price, p.contractor_cost_cents AS p_cost
     FROM projects p
     JOIN job_requests j ON j.id = p.job_request_id
     LEFT JOIN quotes q ON q.id = p.quote_id
     ORDER BY p.id DESC`
  ).all();
  const pct = (price, cost) => price ? Math.round((price - cost) / price * 100) : 0;
  res.json(rows.map(r => ({
    project_id: r.id, stage: r.stage, service_type: r.service_type,
    projected_price_cents: r.q_price, projected_margin_pct: pct(r.q_price, r.q_cost),
    actual_price_cents: r.p_price, actual_margin_pct: pct(r.p_price, r.p_cost),
  })));
}));

// ---- Average ticket by service type and by month ----
router.get('/ticket', ah(async (req, res) => {
  const byTrade = await db.prepare(
    `SELECT j.service_type, COUNT(*) AS jobs, ROUND(AVG(p.customer_price_cents)) AS avg_cents
     FROM projects p JOIN job_requests j ON j.id = p.job_request_id
     GROUP BY j.service_type ORDER BY jobs DESC`
  ).all();
  // PostgreSQL's created_at is a TIMESTAMPTZ (substr() does not accept it); SQLite stores text.
  const monthExpr = db._isPg ? `to_char(p.created_at, 'YYYY-MM')` : `substr(p.created_at,1,7)`;
  const byMonth = await db.prepare(
    `SELECT ${monthExpr} AS month, COUNT(*) AS jobs, ROUND(AVG(p.customer_price_cents)) AS avg_cents
     FROM projects p GROUP BY month ORDER BY month`
  ).all();
  res.json({ by_service_type: byTrade, by_month: byMonth });
}));

// ---- Contractor performance ----
router.get('/contractors', ah(async (req, res) => {
  const rows = await db.prepare(
    `SELECT c.id, c.legal_name, c.city, c.status, c.rating_avg, c.jobs_completed,
            u.name AS contact_name,
            (SELECT COUNT(*) FROM projects p WHERE p.contractor_id = c.id AND p.stage = 'completed') AS done,
            (SELECT COUNT(*) FROM projects p WHERE p.contractor_id = c.id AND p.stage IN ('assigned','scheduled','in_progress','review')) AS active_now,
            (SELECT COALESCE(SUM(customer_price_cents),0) FROM projects p WHERE p.contractor_id = c.id AND p.stage = 'completed') AS revenue_cents
     FROM contractors c JOIN users u ON u.id = c.user_id ORDER BY revenue_cents DESC`
  ).all();
  const enriched = [];
  for (const r of rows) {
    const c = await db.prepare('SELECT * FROM contractors WHERE id = ?').get(r.id);
    enriched.push({ ...r, lifecycle: crm.contractorLifecycle(c) });
  }
  res.json(enriched);
}));

// ---- Estimate-vs-actual calibration ----
router.get('/calibration', ah(async (req, res) => {
  const rows = await db.prepare(
    `SELECT e.low_cents, e.high_cents, p.customer_price_cents AS actual_cents, j.service_type
     FROM estimates e
     JOIN job_requests j ON j.id = e.job_request_id
     JOIN projects p ON p.job_request_id = j.id
     WHERE p.stage = 'completed' AND p.customer_price_cents > 0`
  ).all();
  const within = rows.filter(r => r.actual_cents >= r.low_cents && r.actual_cents <= r.high_cents).length;
  const overruns = rows.map(r => (r.actual_cents - (r.low_cents + r.high_cents) / 2) / ((r.low_cents + r.high_cents) / 2));
  const avgOverrun = overruns.length ? overruns.reduce((a, b) => a + b, 0) / overruns.length : 0;
  res.json({
    samples: rows.length,
    within_range_pct: rows.length ? Math.round(within / rows.length * 100) : 0,
    avg_deviation_from_midpoint_pct: Math.round(avgOverrun * 100),
    detail: rows,
  });
}));

module.exports = router;
