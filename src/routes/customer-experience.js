'use strict';

const express = require('express');
const db = require('../db');
const { ah, authRequired, requireRole, isNonEmpty, failIfErrors } = require('../middleware');
const { auditLog } = require('../services/audit');
const { notify, shell } = require('../services/notify');

const router = express.Router();

function serviceArea(zip) {
  const exact = String(process.env.SERVICE_ZIPS || '').split(',').map(s => s.trim()).filter(Boolean);
  const prefixes = String(process.env.SERVICE_ZIP_PREFIXES || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!exact.length && !prefixes.length) return { available: null, status: 'needs_review' };
  const available = exact.includes(zip) || prefixes.some(p => zip.startsWith(p));
  return { available, status: available ? 'available' : 'unavailable' };
}

router.get('/service-area', ah(async (req, res) => {
  const zip = String(req.query.zip || '').trim();
  if (!/^\d{5}$/.test(zip)) return res.status(422).json({ error: 'Enter a valid 5-digit ZIP code.' });
  const r = serviceArea(zip);
  res.json({
    zip, ...r,
    message: r.available === true ? 'Helpman currently serves this ZIP.'
      : r.available === false ? 'Helpman is not currently booking this ZIP.'
      : 'We will confirm service availability for this ZIP before booking.'
  });
}));

async function loadVisibleProject(req, res) {
  const p = await db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!p) { res.status(404).json({ error: 'Project not found.' }); return null; }
  if (req.user.role === 'admin') return p;
  if (req.user.role === 'customer') {
    const j = await db.prepare('SELECT customer_id FROM job_requests WHERE id = ?').get(p.job_request_id);
    if (j && j.customer_id === req.user.id) return p;
  }
  if (req.user.role === 'contractor') {
    const c = await db.prepare('SELECT id FROM contractors WHERE user_id = ?').get(req.user.id);
    if (c && c.id === p.contractor_id) return p;
  }
  res.status(403).json({ error: 'Not allowed.' });
  return null;
}

async function addEvent(projectId, eventType, title, detail, actorRole) {
  try {
    await db.prepare(
      `INSERT INTO project_customer_events (project_id,event_type,title,detail,actor_role)
       VALUES (?,?,?,?,?)`
    ).run(projectId, eventType, title, detail || null, actorRole || null);
  } catch (_) {}
}

router.get('/projects/:id/schedule-preference', authRequired, ah(async (req, res) => {
  const p = await loadVisibleProject(req, res); if (!p) return;
  const row = await db.prepare('SELECT * FROM project_schedule_preferences WHERE project_id = ?').get(p.id);
  res.json(row || { project_id: p.id, preferred_date: null, time_window: 'anytime', flexibility: 'flexible', notes: '' });
}));

router.put('/projects/:id/schedule-preference', authRequired, requireRole('customer'), ah(async (req, res) => {
  const p = await loadVisibleProject(req, res); if (!p) return;
  const b = req.body || {};
  const errors = {};
  if (b.preferred_date && isNaN(new Date(b.preferred_date).getTime())) errors.preferred_date = 'Invalid date.';
  if (b.time_window && !['morning','afternoon','evening','anytime'].includes(b.time_window)) errors.time_window = 'Invalid time window.';
  if (b.flexibility && !['exact','plus_minus_1','plus_minus_3','flexible'].includes(b.flexibility)) errors.flexibility = 'Invalid flexibility.';
  if (b.notes && !isNonEmpty(b.notes, 500)) errors.notes = 'Notes must be 500 characters or fewer.';
  if (failIfErrors(res, errors)) return;

  const existing = await db.prepare('SELECT id FROM project_schedule_preferences WHERE project_id = ?').get(p.id);
  if (existing) {
    await db.prepare(`UPDATE project_schedule_preferences
      SET preferred_date=?, time_window=?, flexibility=?, notes=?, updated_by=?, updated_at=CURRENT_TIMESTAMP
      WHERE project_id=?`)
      .run(b.preferred_date || null, b.time_window || 'anytime', b.flexibility || 'flexible', b.notes || null, req.user.id, p.id);
  } else {
    await db.prepare(`INSERT INTO project_schedule_preferences
      (project_id,preferred_date,time_window,flexibility,notes,updated_by)
      VALUES (?,?,?,?,?,?)`)
      .run(p.id, b.preferred_date || null, b.time_window || 'anytime', b.flexibility || 'flexible', b.notes || null, req.user.id);
  }
  await addEvent(p.id, 'schedule_preference', 'Scheduling preference updated',
    `${b.preferred_date || 'No specific date'} · ${b.time_window || 'anytime'} · ${b.flexibility || 'flexible'}`, 'customer');
  res.json(await db.prepare('SELECT * FROM project_schedule_preferences WHERE project_id = ?').get(p.id));
}));

router.get('/projects/:id/change-orders', authRequired, ah(async (req, res) => {
  const p = await loadVisibleProject(req, res); if (!p) return;
  const rows = await db.prepare('SELECT * FROM change_orders WHERE project_id = ? ORDER BY id DESC').all(p.id);
  res.json(rows);
}));

router.post('/projects/:id/change-orders', authRequired, ah(async (req, res) => {
  const p = await loadVisibleProject(req, res); if (!p) return;
  if (!['admin','contractor'].includes(req.user.role)) return res.status(403).json({ error: 'Not allowed.' });
  const b = req.body || {};
  const errors = {};
  if (!isNonEmpty(b.title, 160)) errors.title = 'Title is required.';
  if (!isNonEmpty(b.description, 2500)) errors.description = 'Description is required.';
  if (!Number.isInteger(Number(b.price_delta_cents || 0))) errors.price_delta_cents = 'Invalid price change.';
  if (!Number.isInteger(Number(b.schedule_delta_days || 0))) errors.schedule_delta_days = 'Invalid schedule change.';
  if (failIfErrors(res, errors)) return;

  const info = await db.prepare(`INSERT INTO change_orders
    (project_id,title,description,reason,price_delta_cents,schedule_delta_days,status,created_by)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(p.id, b.title.trim(), b.description.trim(), (b.reason || '').trim() || null,
      Number(b.price_delta_cents || 0), Number(b.schedule_delta_days || 0), 'draft', req.user.id);

  await addEvent(p.id, 'change_order_created', 'Change order drafted', b.title.trim(), req.user.role);
  auditLog(req.user.id, 'change_order.created', 'change_orders', info.lastInsertRowid, `Project #${p.id}`);
  res.status(201).json(await db.prepare('SELECT * FROM change_orders WHERE id = ?').get(info.lastInsertRowid));
}));

router.post('/projects/:id/change-orders/:cid/send', authRequired, ah(async (req, res) => {
  const p = await loadVisibleProject(req, res); if (!p) return;
  if (!['admin','contractor'].includes(req.user.role)) return res.status(403).json({ error: 'Not allowed.' });
  const co = await db.prepare('SELECT * FROM change_orders WHERE id = ? AND project_id = ?').get(req.params.cid, p.id);
  if (!co) return res.status(404).json({ error: 'Change order not found.' });
  if (!['draft','rejected'].includes(co.status)) return res.status(409).json({ error: 'Only draft/rejected change orders can be sent.' });

  await db.prepare(`UPDATE change_orders SET status='sent', sent_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(co.id);
  await addEvent(p.id, 'change_order_sent', 'Change order needs approval', co.title, req.user.role);

  const job = await db.prepare('SELECT * FROM job_requests WHERE id = ?').get(p.job_request_id);
  const email = job.customer_id
    ? ((await db.prepare('SELECT email FROM users WHERE id = ?').get(job.customer_id)) || {}).email
    : job.email;
  if (email) {
    await notify({
      to: email,
      subject: `Action needed: project change #${p.id}`,
      html: shell('Project change needs your approval',
        'A change to your project has been documented in Helpman. Please review it in your customer portal before work proceeds on the changed scope.',
        [['Project', `#${p.id}`], ['Change', co.title]])
    }).catch(() => {});
  }
  res.json(await db.prepare('SELECT * FROM change_orders WHERE id = ?').get(co.id));
}));

router.post('/projects/:id/change-orders/:cid/respond', authRequired, requireRole('customer'), ah(async (req, res) => {
  const p = await loadVisibleProject(req, res); if (!p) return;
  const co = await db.prepare('SELECT * FROM change_orders WHERE id = ? AND project_id = ?').get(req.params.cid, p.id);
  if (!co) return res.status(404).json({ error: 'Change order not found.' });
  if (co.status !== 'sent') return res.status(409).json({ error: 'This change order is not awaiting a response.' });

  const approved = (req.body || {}).approved === true;
  const note = String((req.body || {}).note || '').trim().slice(0, 1000);
  await db.prepare(`UPDATE change_orders
    SET status=?, customer_note=?, responded_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(approved ? 'approved' : 'rejected', note || null, co.id);

  await addEvent(p.id, approved ? 'change_order_approved' : 'change_order_rejected',
    approved ? 'Change order approved' : 'Change order rejected', co.title, 'customer');

  auditLog(req.user.id, approved ? 'change_order.approved' : 'change_order.rejected',
    'change_orders', co.id, `Project #${p.id}`);

  res.json(await db.prepare('SELECT * FROM change_orders WHERE id = ?').get(co.id));
}));

router.get('/projects/:id/timeline', authRequired, ah(async (req, res) => {
  const p = await loadVisibleProject(req, res); if (!p) return;
  const rows = await db.prepare('SELECT * FROM project_customer_events WHERE project_id = ? ORDER BY id DESC LIMIT 100').all(p.id);
  res.json(rows);
}));

module.exports = router;
