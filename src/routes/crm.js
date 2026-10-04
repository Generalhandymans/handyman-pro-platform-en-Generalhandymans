// CRM endpoints: two-sided pipeline views, follow-up tasks, segments.
const express = require('express');
const db = require('../db');
const { ah, authRequired, requireRole } = require('../middleware');
const crm = require('../services/crm');

const router = express.Router();
router.use(authRequired, requireRole('admin'));

// ---- CLIENT pipeline: counts + pipeline value per stage ----
router.get('/pipeline', ah(async (req, res) => {
  const rows = db.prepare(
    `SELECT j.status,
            COUNT(*) AS count,
            COALESCE(SUM(q.customer_price_cents), 0) AS value_cents
     FROM job_requests j
     LEFT JOIN quotes q ON q.id = (
       SELECT id FROM quotes WHERE job_request_id = j.id ORDER BY id DESC LIMIT 1
     )
     GROUP BY j.status ORDER BY count DESC`
  ).all();
  const scores = db.prepare(
    `SELECT status, ROUND(AVG(lead_score)) AS avg_score FROM job_requests GROUP BY status`
  ).all();
  const avgByStatus = Object.fromEntries(scores.map(s => [s.status, s.avg_score]));
  res.json(rows.map(r => ({ ...r, avg_lead_score: avgByStatus[r.status] || 0 })));
}));

// ---- Follow-up tasks ----
router.get('/tasks', ah(async (req, res) => {
  const { status } = req.query;
  const rows = status
    ? db.prepare('SELECT * FROM followup_tasks WHERE status = ? ORDER BY id DESC').all(status)
    : db.prepare('SELECT * FROM followup_tasks ORDER BY status, id DESC LIMIT 200').all();
  res.json(rows);
}));

router.post('/tasks/generate', ah(async (req, res) => {
  res.json({ created: crm.generateFollowupTasks() });
}));

router.patch('/tasks/:id/done', ah(async (req, res) => {
  db.prepare(`UPDATE followup_tasks SET status = 'done' WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
}));

// ---- CONTRACTOR pipeline: lifecycle stages with counts ----
router.get('/contractors', ah(async (req, res) => {
  const rows = db.prepare('SELECT * FROM contractors').all();
  const by = {};
  const list = rows.map(c => {
    const lc = crm.contractorLifecycle(c);
    by[lc] = (by[lc] || 0) + 1;
    return {
      id: c.id, legal_name: c.legal_name, city: c.city, specialties: c.specialties,
      status: c.status, lifecycle: lc, score: crm.contractorScore(c),
      retention_at_risk: crm.retentionAtRisk(c), rating_avg: c.rating_avg, jobs_completed: c.jobs_completed,
    };
  });
  res.json({ stages: by, contractors: list });
}));

// ---- Demand vs supply gaps (recruitment planning, not emails) ----
router.get('/recruitment-gaps', ah(async (req, res) => {
  res.json(crm.recruitmentGaps());
}));

// ---- Email log (everything ever sent/attempted) ----
router.get('/email-log', ah(async (req, res) => {
  res.json(db.prepare('SELECT * FROM email_log ORDER BY id DESC LIMIT 200').all());
}));

// ---- Segments preview (for the campaign builder) ----
router.get('/segments/:name', ah(async (req, res) => {
  try {
    const members = crm.segmentMembers(req.params.name);
    res.json({ segment: req.params.name, count: members.length, sample: members.slice(0, 5) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

module.exports = router;
