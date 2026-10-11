// AI assistant for SUPPORT STAFF: reply drafts (messages and disputes), a handoff summary, usage.
// HUMAN IN THE LOOP: there is no endpoint here that sends anything to a customer or contractor.
// A draft fills the normal composer; the person edits it and sends it through the usual screen,
// and the screen then reports back with /drafts/:id/mark.
'use strict';
const express = require('express');
const db = require('../db');
const { ah, authRequired, isInt, isNonEmpty, failIfErrors } = require('../middleware');
const { requireStaff, can } = require('../services/permissions');
const { auditLog } = require('../services/audit');
const ai = require('../services/ai');
const { customerBalanceCents } = require('../services/payables');

const router = express.Router();
router.use(authRequired);

const LIMIT_PER_HOUR = () => Number(process.env.AI_DRAFTS_PER_HOUR) || 30;
const STAGE = (s) => String(s || '').replace(/_/g, ' ');
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

async function recentMessages(threadId, limit = 12) {
  const rows = await db.prepare('SELECT sender_role, body FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?').all(threadId, limit);
  return rows.reverse().map(r => ({ role: r.sender_role, body: r.body }));
}

router.post('/drafts', requireStaff('support'), ah(async (req, res) => {
  const b = req.body || {};
  const errors = {};
  if (!isInt(b.thread_id, 1, 1e9) && !isInt(b.dispute_id, 1, 1e9)) errors.thread_id = 'Send a thread_id or a dispute_id.';
  if (failIfErrors(res, errors)) return;

  // Cost/abuse guard: a person can ask for a limited number of drafts per hour.
  const used = await db.prepare('SELECT COUNT(*) c FROM ai_drafts WHERE created_by = ? AND created_at >= ?').get(req.user.id, sqlTime(Date.now() - 3600 * 1000));
  if (Number(used.c) >= LIMIT_PER_HOUR()) return res.status(429).json({ error: 'Draft limit reached for this hour. Try again later.' });

  let ctx, row;
  if (isInt(b.thread_id, 1, 1e9)) {
    const t = await db.prepare('SELECT * FROM message_threads WHERE id = ?').get(b.thread_id);
    if (!t) return res.status(404).json({ error: 'Thread not found.' });
    const p = await db.prepare('SELECT stage, job_request_id FROM projects WHERE id = ?').get(t.project_id);
    const job = p ? await db.prepare('SELECT service_type FROM job_requests WHERE id = ?').get(p.job_request_id) : null;
    const audience = t.kind === 'client_support' ? 'customer' : 'contractor';
    const dsp = await require('../services/disputes').openDisputeFor(t.project_id);
    ctx = { kind: 'message_reply', audience, facts: { service: job && job.service_type, stage: p && STAGE(p.stage), dispute_open: !!dsp }, messages: await recentMessages(t.id) };
    row = { kind: 'message_reply', thread_id: t.id, dispute_id: null, project_id: t.project_id, audience };
  } else {
    const d = await db.prepare('SELECT * FROM disputes WHERE id = ?').get(b.dispute_id);
    if (!d) return res.status(404).json({ error: 'Dispute not found.' });
    if (!['open', 'investigating'].includes(d.status)) return res.status(409).json({ error: 'This dispute is closed.' });
    const audience = b.audience === 'contractor' ? 'contractor' : 'customer';
    const p = await db.prepare('SELECT stage, job_request_id FROM projects WHERE id = ?').get(d.project_id);
    const job = p ? await db.prepare('SELECT service_type FROM job_requests WHERE id = ?').get(p.job_request_id) : null;
    // ONLY the channel this reply goes to: the other side's messages never reach the draft.
    const evs = await db.prepare('SELECT author_role, body FROM dispute_events WHERE dispute_id = ? AND visibility = ? ORDER BY id').all(d.id, audience);
    const msgs = [];
    if (d.opened_by_role === audience) msgs.push({ role: audience, body: d.description }); // their own complaint
    for (const e of evs) msgs.push({ role: e.author_role, body: e.body });
    ctx = { kind: 'dispute_reply', audience, facts: { service: job && job.service_type, stage: p && STAGE(p.stage), reason: d.reason, dispute_open: true }, messages: msgs.slice(-12) };
    row = { kind: 'dispute_reply', thread_id: null, dispute_id: d.id, project_id: d.project_id, audience };
  }

  const out = await ai.draft(ctx);
  const info = await db.prepare(
    `INSERT INTO ai_drafts (kind, thread_id, dispute_id, project_id, audience, provider, model, body, flags, prompt_tokens, completion_tokens, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(row.kind, row.thread_id, row.dispute_id, row.project_id, row.audience, out.provider, out.model, out.body, JSON.stringify(out.flags), out.prompt_tokens, out.completion_tokens, req.user.id);
  res.status(201).json({
    id: info.lastInsertRowid, body: out.body, flags: out.flags, provider: out.provider, audience: row.audience,
    note: out.provider === 'openai' ? 'AI-written draft. Read it, edit it, then send it yourself.' : 'Template draft (no AI is configured). Read it, edit it, then send it yourself.',
  });
}));

// The screen reports what the person did with the draft.
router.post('/drafts/:id/mark', requireStaff('support'), ah(async (req, res) => {
  const d = await db.prepare('SELECT * FROM ai_drafts WHERE id = ?').get(req.params.id);
  if (!d || (d.created_by !== req.user.id && !can(req.user, 'staff'))) return res.status(404).json({ error: 'Draft not found.' });
  const b = req.body || {};
  if (!['sent', 'discarded'].includes(b.status)) return res.status(422).json({ error: 'Validation failed', fields: { status: 'sent or discarded' } });
  let final = null, edited = 0;
  if (b.status === 'sent') {
    if (!isNonEmpty(b.final_body, 2000)) return res.status(422).json({ error: 'Validation failed', fields: { final_body: 'Send the text that was actually sent.' } });
    final = b.final_body.trim();
    edited = final === String(d.body).trim() ? 0 : 1;
  }
  const upd = await db.prepare(`UPDATE ai_drafts SET status = ?, final_body = ?, edited = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'draft'`).run(b.status, final, edited, d.id);
  if (upd.changes !== 1) return res.status(409).json({ error: 'This draft was already handled.' });
  res.json({ id: d.id, status: b.status, edited: !!edited, similarity: final ? ai.similarity(d.body, final) : null });
}));

// ---- Handoff summary of a project: deterministic facts (NO AI, nothing leaves the server) ----
router.post('/summary', requireStaff('read'), ah(async (req, res) => {
  const pid = (req.body || {}).project_id;
  if (!isInt(pid, 1, 1e9)) return res.status(422).json({ error: 'Validation failed', fields: { project_id: 'Project is required.' } });
  const p = await db.prepare('SELECT * FROM projects WHERE id = ?').get(pid);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  const job = await db.prepare('SELECT service_type, urgency, city FROM job_requests WHERE id = ?').get(p.job_request_id);
  const con = p.contractor_id ? await db.prepare('SELECT COALESCE(c.legal_name, u.name) AS name FROM contractors c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(p.contractor_id) : null;
  const ms = await db.prepare('SELECT status, customer_approval FROM milestones WHERE project_id = ?').all(pid);
  const disp = await db.prepare(`SELECT id, status, reason FROM disputes WHERE project_id = ? ORDER BY id DESC`).all(pid);
  const visits = await db.prepare('SELECT outcome FROM visit_events WHERE project_id = ?').all(pid);
  const sheet = await db.prepare('SELECT signed_at FROM completion_sheets WHERE project_id = ?').get(pid);
  const balance = await customerBalanceCents(pid);
  const money = (c) => '$' + (c / 100).toFixed(2);
  const lines = [];
  lines.push(`${job ? job.service_type : 'Project'} in ${job && job.city ? job.city : '—'}${job && job.urgency === 'urgent' ? ' (urgent)' : ''} — stage: ${STAGE(p.stage)}.`);
  lines.push(con ? `Contractor: ${con.name} (${p.contractor_status || 'assigned'}).` : 'No contractor assigned yet.');
  lines.push(p.scheduled_start ? `Scheduled: ${String(p.scheduled_start).slice(0, 10)}${p.scheduled_end && p.scheduled_end !== p.scheduled_start ? ' to ' + String(p.scheduled_end).slice(0, 10) : ''}.` : 'No visit date yet.');
  lines.push(`Milestones: ${ms.filter(m => m.customer_approval === 'approved').length} of ${ms.length} approved by the customer; ${ms.filter(m => m.customer_approval === 'rejected').length} rejected.`);
  lines.push(`Customer price ${money(p.customer_price_cents)}; still owed by the customer: ${money(balance)}.`);
  if (can(req.user, 'costs')) lines.push(`Contractor budget: ${money(p.contractor_cost_cents)}.`);
  lines.push(sheet ? `Completion sheet signed on ${String(sheet.signed_at).slice(0, 10)}.` : 'Completion sheet not signed.');
  const openD = disp.find(d => ['open', 'investigating'].includes(d.status));
  lines.push(openD ? `OPEN DISPUTE #${openD.id} (${openD.reason}): payments are on hold.` : (disp.length ? `${disp.length} past dispute(s), none open.` : 'No disputes.'));
  const ns = visits.filter(v => /no_show/.test(v.outcome)).length;
  if (visits.length) lines.push(`Visits logged: ${visits.length}${ns ? `, ${ns} no-show(s)` : ''}.`);
  res.json({ project_id: pid, generated: 'automatic from the database (no AI)', text: lines.join('\n') });
}));

// ---- Usage and how useful the drafts are (owner only) ----
router.get('/usage', requireStaff('staff'), ah(async (req, res) => {
  const rows = await db.prepare(`SELECT provider, status, edited, prompt_tokens, completion_tokens, created_at FROM ai_drafts WHERE created_at >= ?`).all(sqlTime(Date.now() - 30 * 86400000));
  const sent = rows.filter(r => r.status === 'sent');
  const sum = (k) => rows.reduce((a, r) => a + Number(r[k] || 0), 0);
  res.json({
    provider: ai.provider(), window_days: 30, drafts: rows.length,
    by_provider: { openai: rows.filter(r => r.provider === 'openai').length, template: rows.filter(r => r.provider === 'heuristic').length },
    sent: sent.length, sent_unedited: sent.filter(r => !r.edited).length, discarded: rows.filter(r => r.status === 'discarded').length,
    still_open: rows.filter(r => r.status === 'draft').length,
    tokens: { prompt: sum('prompt_tokens'), completion: sum('completion_tokens') },
    limit_per_person_per_hour: LIMIT_PER_HOUR(),
  });
}));

module.exports = router;
