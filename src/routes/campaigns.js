// Mass campaigns: templates, segments, outbox queue, pluggable sending.
// Sending is NEVER fake: default provider logs to console AND records every
// attempt in email_log. See src/services/mailer.js.
const express = require('express');
const db = require('../db');
const { ah, authRequired, requireRole, isNonEmpty, failIfErrors } = require('../middleware');
const crm = require('../services/crm');
const mailer = require('../services/mailer');

const router = express.Router();
router.use(authRequired, requireRole('admin'));

const SEGMENTS = ['all_customers', 'past_customers', 'inactive_clients_90d', 'lost_leads',
  'all_contractors', 'pending_contractors', 'top_contractors'];

// ---- Templates ----
router.get('/templates', ah(async (req, res) => {
  res.json(db.prepare('SELECT * FROM email_templates ORDER BY id DESC').all());
}));

router.post('/templates', ah(async (req, res) => {
  const b = req.body || {};
  const errors = {};
  if (!isNonEmpty(b.name, 120)) errors.name = 'Name required.';
  if (!isNonEmpty(b.subject, 200)) errors.subject = 'Subject required.';
  if (!isNonEmpty(b.body_html, 20000)) errors.body_html = 'Body required. Use {{name}} style variables.';
  if (failIfErrors(res, errors)) return;
  const info = db.prepare('INSERT INTO email_templates (name, subject, body_html) VALUES (?,?,?)')
    .run(b.name.trim(), b.subject.trim(), b.body_html);
  res.status(201).json(db.prepare('SELECT * FROM email_templates WHERE id = ?').get(info.lastInsertRowid));
}));

// ---- Campaigns ----
router.get('/', ah(async (req, res) => {
  res.json(db.prepare(
    `SELECT c.*, t.name AS template_name,
       (SELECT COUNT(*) FROM email_outbox o WHERE o.campaign_id = c.id) AS recipients,
       (SELECT COUNT(*) FROM email_outbox o WHERE o.campaign_id = c.id AND o.status = 'sent') AS sent
     FROM campaigns c LEFT JOIN email_templates t ON t.id = c.template_id ORDER BY c.id DESC`
  ).all());
}));

router.post('/', ah(async (req, res) => {
  const b = req.body || {};
  const errors = {};
  if (!isNonEmpty(b.name, 160)) errors.name = 'Name required.';
  if (!SEGMENTS.includes(b.segment)) errors.segment = 'Unknown segment.';
  if (!db.prepare('SELECT id FROM email_templates WHERE id = ?').get(b.template_id)) errors.template_id = 'Template not found.';
  if (failIfErrors(res, errors)) return;
  const info = db.prepare('INSERT INTO campaigns (name, segment, template_id) VALUES (?,?,?)')
    .run(b.name.trim(), b.segment, b.template_id);
  res.status(201).json(db.prepare('SELECT * FROM campaigns WHERE id = ?').get(info.lastInsertRowid));
}));

// Resolve the segment into the outbox (one row per recipient). Idempotent-ish:
// re-queueing skips addresses already queued for this campaign.
router.post('/:id/queue', ah(async (req, res) => {
  const c = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Campaign not found.' });
  const t = db.prepare('SELECT * FROM email_templates WHERE id = ?').get(c.template_id);
  if (!t) return res.status(400).json({ error: 'Template missing.' });

  let members;
  try { members = crm.segmentMembers(c.segment); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  const have = new Set(db.prepare('SELECT to_email FROM email_outbox WHERE campaign_id = ?').all(c.id).map(r => r.to_email));
  const ins = db.prepare(
    `INSERT INTO email_outbox (campaign_id, to_email, to_name, subject, body_html, provider)
     VALUES (?,?,?,?,?,?)`
  );
  let queued = 0;
  const tx = db.transaction(() => {
    for (const m of members) {
      if (!m.email || have.has(m.email)) continue;
      const vars = { name: m.name || 'there', company: 'Handyman Pro', ...(m.context || {}) };
      ins.run(c.id, m.email, m.name, crm.renderTemplate(t.subject, vars),
        crm.renderTemplate(t.body_html, vars), mailer.activeProvider());
      queued++;
    }
    db.prepare(`UPDATE campaigns SET status = 'queued' WHERE id = ?`).run(c.id);
  });
  tx();
  res.json({ queued, campaign_id: c.id });
}));

// Mark for sending; the background worker (server.js) drains the outbox.
router.post('/:id/send', ah(async (req, res) => {
  const c = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Campaign not found.' });
  db.prepare(`UPDATE campaigns SET status = 'sending' WHERE id = ?`).run(c.id);
  const n = processOutbox(50); // also flush a batch right now for immediacy
  res.json({ status: 'sending', flushed_now: n });
}));

router.get('/:id/outbox', ah(async (req, res) => {
  res.json(db.prepare('SELECT id, to_email, to_name, subject, status, provider, error, sent_at FROM email_outbox WHERE campaign_id = ? ORDER BY id').all(req.params.id));
}));

// ---- Outbox worker: drains queued rows, logs EVERY attempt ----
function processOutbox(limit = 50) {
  const rows = db.prepare(`SELECT * FROM email_outbox WHERE status = 'queued' ORDER BY id LIMIT ?`).all(limit);
  let done = 0;
  const mark = db.prepare(`UPDATE email_outbox SET status = ?, sent_at = ?, error = ? WHERE id = ?`);
  const log = db.prepare(`INSERT INTO email_log (outbox_id, to_email, subject, status, provider) VALUES (?,?,?,?,?)`);
  for (const r of rows) {
    mark.run('sending', null, null, r.id);
    mailer.send({ to: r.to_email, subject: r.subject, html: r.body_html })
      .then(result => {
        mark.run(result.ok ? 'sent' : 'failed', result.ok ? new Date().toISOString() : null, result.error || null, r.id);
        log.run(r.id, r.to_email, r.subject, result.ok ? 'sent' : 'failed', result.provider);
        // Close out finished campaigns.
        const pending = db.prepare(`SELECT COUNT(*) c FROM email_outbox WHERE campaign_id = ? AND status IN ('queued','sending')`).get(r.campaign_id).c;
        if (pending === 0) db.prepare(`UPDATE campaigns SET status = 'done' WHERE id = ?`).run(r.campaign_id);
      })
      .catch(err => {
        mark.run('failed', null, String(err.message).slice(0, 200), r.id);
        log.run(r.id, r.to_email, r.subject, 'failed', r.provider);
      });
    done++;
  }
  return done;
}

module.exports = router;
module.exports.processOutbox = processOutbox;
