'use strict';

const db = require('../db');

const nowMs = () => Date.now();
const ageMinutes = (v) => {
  if (!v) return 0;
  const ms = new Date(String(v).replace(' ', 'T') + (String(v).includes('Z') ? '' : 'Z')).getTime();
  return isNaN(ms) ? 0 : Math.max(0, Math.round((nowMs() - ms) / 60000));
};

async function policyMap() {
  const rows = await db.prepare('SELECT * FROM sla_policies WHERE enabled = 1').all();
  return Object.fromEntries(rows.map(r => [r.code, Number(r.threshold_minutes)]));
}

async function upsertSystemTask({ title, detail, entityType, entityId, priority='medium', source='system', fingerprint, dueAt=null }) {
  if (fingerprint) {
    const existing = await db.prepare(
      `SELECT * FROM operations_tasks
       WHERE fingerprint = ? AND status IN ('open','in_progress','blocked')
       ORDER BY id DESC LIMIT 1`
    ).get(fingerprint);
    if (existing) return existing;
  }
  const info = await db.prepare(
    `INSERT INTO operations_tasks
      (title,detail,entity_type,entity_id,priority,status,due_at,source,fingerprint)
     VALUES (?,?,?,?,?,'open',?,?,?)`
  ).run(title, detail || null, entityType || null, entityId || null, priority, dueAt, source, fingerprint || null);
  return await db.prepare('SELECT * FROM operations_tasks WHERE id = ?').get(info.lastInsertRowid);
}

async function generateOperationalTasks() {
  const p = await policyMap();
  const made = [];

  // 1) New leads with no estimate/action.
  const leads = await db.prepare(
    `SELECT j.* FROM job_requests j
     WHERE j.status = 'new'
     ORDER BY j.id`
  ).all();
  for (const j of leads) {
    if (ageMinutes(j.created_at) >= (p.new_lead_first_action || 60)) {
      made.push(await upsertSystemTask({
        title: `New lead needs action — #${j.id}`,
        detail: `${j.service_type} · ${j.city || ''} ${j.state || ''}`.trim(),
        entityType: 'job_request', entityId: j.id, priority: 'high', source: 'sla',
        fingerprint: `sla:new-lead:${j.id}`
      }));
    }
  }

  // 2) Sent quotes waiting > threshold.
  const quotes = await db.prepare(
    `SELECT q.*, j.name, j.service_type FROM quotes q
     JOIN job_requests j ON j.id = q.job_request_id
     WHERE q.status = 'sent'`
  ).all();
  for (const q of quotes) {
    if (ageMinutes(q.sent_at || q.created_at) >= (p.quote_response_followup || 2880)) {
      made.push(await upsertSystemTask({
        title: `Quote waiting for response — #${q.id}`,
        detail: `${q.name || 'Customer'} · ${q.service_type}`,
        entityType: 'quote', entityId: q.id, priority: 'medium', source: 'sla',
        fingerprint: `sla:quote:${q.id}`
      }));
    }
  }

  // 3) Projects accepted but unassigned.
  const projects = await db.prepare(
    `SELECT p.*, j.service_type, j.city, j.state FROM projects p
     JOIN job_requests j ON j.id = p.job_request_id
     WHERE p.stage = 'assigned' AND p.contractor_id IS NULL`
  ).all();
  for (const x of projects) {
    if (ageMinutes(x.created_at) >= (p.unassigned_project || 240)) {
      made.push(await upsertSystemTask({
        title: `Project needs dispatch — #${x.id}`,
        detail: `${x.service_type} · ${x.city || ''} ${x.state || ''}`.trim(),
        entityType: 'project', entityId: x.id, priority: 'critical', source: 'dispatch',
        fingerprint: `dispatch:unassigned:${x.id}`
      }));
    }
  }

  // 4) Contractor offer waiting too long.
  const offered = await db.prepare(
    `SELECT p.*, j.service_type FROM projects p
     JOIN job_requests j ON j.id = p.job_request_id
     WHERE p.contractor_status = 'offered'`
  ).all();
  for (const x of offered) {
    if (ageMinutes(x.updated_at || x.created_at) >= (p.contractor_offer_response || 120)) {
      made.push(await upsertSystemTask({
        title: `Contractor offer needs follow-up — project #${x.id}`,
        detail: x.service_type,
        entityType: 'project', entityId: x.id, priority: 'high', source: 'dispatch',
        fingerprint: `dispatch:offer:${x.id}`
      }));
    }
  }

  // 5) Milestones completed but waiting for customer approval.
  const milestones = await db.prepare(
    `SELECT m.*, p.job_request_id FROM milestones m
     JOIN projects p ON p.id = m.project_id
     WHERE m.status = 'completed' AND m.customer_approval = 'pending'`
  ).all();
  for (const m of milestones) {
    if (ageMinutes(m.created_at) >= (p.customer_approval_wait || 2880)) {
      made.push(await upsertSystemTask({
        title: `Customer approval pending — project #${m.project_id}`,
        detail: m.title,
        entityType: 'milestone', entityId: m.id, priority: 'medium', source: 'customer',
        fingerprint: `customer:milestone:${m.id}`
      }));
    }
  }

  // 6) Failed payments.
  const failed = await db.prepare(
    `SELECT * FROM payments WHERE status = 'failed' ORDER BY id`
  ).all();
  for (const pay of failed) {
    made.push(await upsertSystemTask({
      title: `Payment failed — project #${pay.project_id}`,
      detail: `${pay.kind} · ${pay.amount_cents} cents`,
      entityType: 'payment', entityId: pay.id, priority: 'critical', source: 'payment',
      fingerprint: `payment:failed:${pay.id}`
    }));
  }

  // 7) Compliance documents expired or expiring within 30 days (if Phase 3 exists).
  try {
    const docs = await db.prepare(
      `SELECT d.*, c.legal_name FROM contractor_documents d
       JOIN contractors c ON c.id = d.contractor_id
       WHERE d.expires_on IS NOT NULL AND d.status IN ('submitted','verified')`
    ).all();
    for (const d of docs) {
      const days = Math.ceil((new Date(d.expires_on).getTime() - Date.now()) / 86400000);
      if (days <= 30) {
        made.push(await upsertSystemTask({
          title: `${days < 0 ? 'Expired' : 'Expiring'} contractor document — ${d.legal_name}`,
          detail: `${d.doc_type} · ${d.expires_on}`,
          entityType: 'contractor_document', entityId: d.id,
          priority: days < 0 ? 'critical' : 'high', source: 'compliance',
          fingerprint: `compliance:doc:${d.id}:${d.expires_on}`
        }));
      }
    }
  } catch (_) {
    // Phase 3 tables may not yet exist during staged upgrades.
  }

  return made.filter(Boolean);
}

async function controlCenter() {
  const one = async (sql, ...args) => await db.prepare(sql).get(...args);

  const [
    newLeads, sentQuotes, unassigned, activeProjects, approvals,
    failedPayments, openTasks, criticalTasks, activePros, pendingPros
  ] = await Promise.all([
    one(`SELECT COUNT(*) c FROM job_requests WHERE status='new'`),
    one(`SELECT COUNT(*) c FROM quotes WHERE status='sent'`),
    one(`SELECT COUNT(*) c FROM projects WHERE stage='assigned' AND contractor_id IS NULL`),
    one(`SELECT COUNT(*) c FROM projects WHERE stage IN ('assigned','scheduled','in_progress','review')`),
    one(`SELECT COUNT(*) c FROM milestones WHERE status='completed' AND customer_approval='pending'`),
    one(`SELECT COUNT(*) c FROM payments WHERE status='failed'`),
    one(`SELECT COUNT(*) c FROM operations_tasks WHERE status IN ('open','in_progress','blocked')`),
    one(`SELECT COUNT(*) c FROM operations_tasks WHERE status IN ('open','in_progress','blocked') AND priority='critical'`),
    one(`SELECT COUNT(*) c FROM contractors WHERE status='active'`),
    one(`SELECT COUNT(*) c FROM contractors WHERE status='pending'`)
  ]);

  const queue = await db.prepare(
    `SELECT t.*, u.name AS assignee_name
     FROM operations_tasks t
     LEFT JOIN users u ON u.id = t.assigned_to
     WHERE t.status IN ('open','in_progress','blocked')
     ORDER BY
       CASE t.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
       CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END,
       t.due_at, t.id DESC
     LIMIT 50`
  ).all();

  return {
    kpis: {
      new_leads: Number(newLeads.c || 0),
      quotes_waiting: Number(sentQuotes.c || 0),
      unassigned_projects: Number(unassigned.c || 0),
      active_projects: Number(activeProjects.c || 0),
      customer_approvals: Number(approvals.c || 0),
      failed_payments: Number(failedPayments.c || 0),
      open_tasks: Number(openTasks.c || 0),
      critical_tasks: Number(criticalTasks.c || 0),
      active_contractors: Number(activePros.c || 0),
      pending_contractors: Number(pendingPros.c || 0),
    },
    queue
  };
}

module.exports = { generateOperationalTasks, controlCenter, upsertSystemTask };
