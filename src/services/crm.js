// Two-sided CRM engine.
// CLIENT side:    lead -> quote -> project -> review -> referral/repurchase
// CONTRACTOR side: applicant -> verification -> active -> performance -> retention
const db = require('../db');

// Backend-aware datetime arithmetic: SQLite datetime() vs PostgreSQL INTERVAL.
const dt = (modifier) => {
  if (db._isPg) {
    const sign = modifier.startsWith('-') ? '-' : '+';
    const unit = modifier.replace(/^[+-]/, '');
    return `CURRENT_TIMESTAMP ${sign} INTERVAL '${unit}'`;
  }
  return `datetime(CURRENT_TIMESTAMP,'${modifier}')`;
};

// ---------------------------------------------------------------------------
// CLIENT SIDE
// ---------------------------------------------------------------------------

// Lead score 0-100. Recomputed whenever the job or its interactions change.
async function computeLeadScore(job) {
  let s = 0;
  if (job.email) s += 8;
  if (job.phone) s += 8;
  if (job.address) s += 8;
  if (job.description && job.description.trim().length > 50) s += 8;
  const photos = await db.prepare('SELECT COUNT(*) c FROM photos WHERE job_request_id = ?').get(job.id).c;
  if (photos > 0) s += 8;                       // 40 max for completeness
  if (job.urgency === 'urgent') s += 10;        // urgency signal
  const ageDays = (Date.now() - new Date(job.created_at + 'Z').getTime()) / 86400000;
  if (ageDays <= 1) s += 20;
  else if (ageDays <= 7) s += 15;
  else if (ageDays <= 30) s += 10;
  else s += 5;                                  // recency
  const kinds = await db.prepare(
    'SELECT kind, COUNT(*) c FROM interactions WHERE job_request_id = ? GROUP BY kind'
  ).all(job.id);
  for (const k of kinds) {
    if (k.kind === 'estimate_requested') s += 10;
    if (k.kind === 'quote_viewed') s += 10;
    if (k.kind === 'customer_reply') s += 5;
  }
  return Math.max(0, Math.min(100, Math.round(s)));
}

async function refreshLeadScore(jobId) {
  try {
    const job = await db.prepare('SELECT * FROM job_requests WHERE id = ?').get(jobId);
    if (!job) return;
    const score = await computeLeadScore(job);
    await db.prepare('UPDATE job_requests SET lead_score = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(score, jobId);
  } catch (e) { /* lead scoring must never break the request */ }
}

async function touchInteraction(jobId, kind, detail) {
  try {
    await db.prepare('INSERT INTO interactions (job_request_id, kind, detail) VALUES (?,?,?)')
      .run(jobId, kind, detail || null);
    await refreshLeadScore(jobId);
  } catch (e) { /* interactions must never break the request */ }
}

// Follow-up task rules. Returns the tasks created on this run.
async function generateFollowupTasks() {
  const created = [];
  const addTask = async (jobId, quoteId, kind, title) => {
    const dup = await db.prepare(
      'SELECT id FROM followup_tasks WHERE kind = ? AND status = \'open\' AND ' +
      '(job_request_id = ? OR (job_request_id IS NULL AND ? IS NULL))'
    ).get(kind, jobId, jobId);
    if (dup) return;
    const info = await db.prepare(
      'INSERT INTO followup_tasks (job_request_id, quote_id, kind, title, due_at) VALUES (?,?,?,?,datetime(CURRENT_TIMESTAMP,\'+1 day\'))'
    ).run(jobId, quoteId, kind, title);
    created.push({ id: info.lastInsertRowid, kind, title, job_request_id: jobId });
  };

  // Rule 1: quote sent, no response for 48h+ -> follow up.
  // NOTE: sent_at is stored ISO; normalize with datetime() before comparing.
  const stale = await db.prepare(
    `SELECT q.id AS qid, q.job_request_id AS jid FROM quotes q
     WHERE q.status = 'sent' AND datetime(q.sent_at) < ${dt('-48 hours')}`
  ).all();
  for (const r of stale) {
    await addTask(r.jid, r.qid, 'quote_followup_48h',
      `Quote #${r.qid} sent 48h+ ago with no response — follow up (job #${r.jid}).`);
  }

  // Rule 2: new request older than 24h with no estimate -> run estimate.
  const noEst = await db.prepare(
    `SELECT j.id FROM job_requests j
     LEFT JOIN estimates e ON e.job_request_id = j.id
     WHERE j.status = 'new' AND j.created_at < ${dt('-24 hours')} AND e.id IS NULL`
  ).all();
  for (const r of noEst) {
    await addTask(r.id, null, 'missing_estimate_24h', `New request #${r.id} is 24h+ old with no estimate — review it.`);
  }

  // Rule 3: project stuck "in_progress" 14d+ with no milestone movement -> check in.
  const stuck = await db.prepare(
    `SELECT p.id, p.job_request_id FROM projects p
     WHERE p.stage = 'in_progress' AND p.updated_at < ${dt('-14 days')}`
  ).all();
  for (const r of stuck) {
    await addTask(r.job_request_id, null, 'stalled_project_14d',
      `Project #${r.id} (job #${r.job_request_id}) shows no progress in 14+ days — check in with contractor.`);
  }
  return created;
}

// ---------------------------------------------------------------------------
// CONTRACTOR SIDE
// ---------------------------------------------------------------------------

// Lifecycle stage derived from verification fields + performance.
function contractorLifecycle(c) {
  if (c.status === 'suspended') return 'suspended';
  if (c.background_check === 'failed') return 'rejected';
  if (c.status === 'pending') {
    const verified = c.license_verified && c.insurance_verified && c.background_check === 'passed';
    return verified ? 'ready_to_activate' : 'verification';
  }
  if (c.status === 'active') {
    if ((c.jobs_completed || 0) === 0) return 'new_active';
    if ((c.rating_avg || 0) >= 4.5) return 'top_performer';
    return 'active';
  }
  return 'applicant';
}

// Performance score 0-100 for retention decisions.
function contractorScore(c) {
  let s = 40;
  s += ((c.rating_avg || 0) / 5) * 40;
  s += Math.min(20, (c.jobs_completed || 0) * 2);
  return Math.max(0, Math.min(100, Math.round(s)));
}

// Retention risk: active contractor with no project activity in 60+ days.
async function retentionAtRisk(c) {
  if (c.status !== 'active') return false;
  const row = await db.prepare(
    `SELECT MAX(p.updated_at) AS last FROM projects p WHERE p.contractor_id = ?`
  ).get(c.id);
  if (!row.last) return (c.jobs_completed || 0) === 0;
  const days = (Date.now() - new Date(row.last + 'Z').getTime()) / 86400000;
  return days > 60;
}

// ---------------------------------------------------------------------------
// CAMPAIGN SEGMENTS (email-able audiences, resolved with real queries)
// ---------------------------------------------------------------------------
async function segmentMembers(segment) {
  switch (segment) {
    case 'all_customers':
      return await db.prepare(
        `SELECT DISTINCT email AS email, name FROM job_requests WHERE email IS NOT NULL AND email != ''`
      ).all().map(r => ({ ...r, context: {} }));

    case 'past_customers':
      return await db.prepare(
        `SELECT DISTINCT j.email AS email, j.name AS name FROM job_requests j
         JOIN projects p ON p.job_request_id = j.id
         WHERE p.stage = 'completed' AND j.email IS NOT NULL AND j.email != ''`
      ).all().map(r => ({ ...r, context: {} }));

    case 'inactive_clients_90d': {
      // Real customers (completed project or accepted quote) with no activity in 90+ days.
      return await db.prepare(
        `SELECT DISTINCT j.email AS email, j.name AS name FROM job_requests j
         WHERE j.email IS NOT NULL AND j.email != ''
           AND j.updated_at < ${dt('-90 days')}
           AND (EXISTS (SELECT 1 FROM projects p WHERE p.job_request_id = j.id AND p.stage = 'completed')
                OR EXISTS (SELECT 1 FROM quotes q WHERE q.job_request_id = j.id AND q.status = 'accepted'))`
      ).all().map(r => ({ ...r, context: {} }));
    }

    case 'lost_leads':
      return await db.prepare(
        `SELECT DISTINCT j.email AS email, j.name AS name, j.service_type AS service_type
         FROM job_requests j
         WHERE j.email IS NOT NULL AND j.email != ''
           AND (j.status = 'lost'
                OR EXISTS (SELECT 1 FROM quotes q WHERE q.job_request_id = j.id AND q.status IN ('rejected','expired')))`
      ).all().map(r => ({ email: r.email, name: r.name, context: { service_type: r.service_type } }));

    case 'all_contractors':
      return await db.prepare(
        `SELECT u.email AS email, u.name AS name FROM contractors c JOIN users u ON u.id = c.user_id`
      ).all().map(r => ({ ...r, context: {} }));

    case 'pending_contractors':
      return await db.prepare(
        `SELECT u.email AS email, u.name AS name FROM contractors c JOIN users u ON u.id = c.user_id
         WHERE c.status = 'pending'`
      ).all().map(r => ({ ...r, context: {} }));

    case 'top_contractors':
      return await db.prepare(
        `SELECT u.email AS email, u.name AS name FROM contractors c JOIN users u ON u.id = c.user_id
         WHERE c.status = 'active' AND c.rating_avg >= 4.5`
      ).all().map(r => ({ ...r, context: {} }));

    default:
      throw new Error('Unknown segment: ' + segment);
  }
}

// Demand-vs-supply gaps: open job requests in (service_type, city) cells with
// zero ACTIVE contractors listing that specialty. Used for recruitment planning
// (a report, not emails — we do not invent prospect addresses).
async function recruitmentGaps() {
  const open = await db.prepare(
    `SELECT service_type, COALESCE(city,'') AS city, COUNT(*) AS open_jobs
     FROM job_requests WHERE status IN ('new','ai_analyzed') GROUP BY service_type, city`
  ).all();
  const gaps = [];
  for (const o of open) {
    const supply = await db.prepare(
      `SELECT COUNT(*) c FROM contractors
       WHERE status = 'active' AND (specialties LIKE '%' || ? || '%') AND (city = ? OR ? = '')`
    ).get(o.service_type, o.city, o.city).c;
    if (supply === 0) gaps.push({ ...o, active_contractors: 0 });
  }
  return gaps;
}

// Tiny template engine: {{name}}, {{service_type}}, {{company}}, {{amount}} ...
function renderTemplate(str, vars) {
  return String(str).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) =>
    vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : '');
}

// Follow-up automation (2026-10-07): runs on a schedule. Generates the tasks,
// then ACTS on the quote reminders: one automatic email per stale quote.
async function runFollowupAutomation() {
  const created = await generateFollowupTasks();
  const emailed = [];
  const pending = await db.prepare(
    `SELECT t.*, q.customer_price_cents, j.name, j.email AS job_email, j.customer_id,
            u.email AS user_email
     FROM followup_tasks t
     LEFT JOIN quotes q ON q.id = t.quote_id
     LEFT JOIN job_requests j ON j.id = t.job_request_id
     LEFT JOIN users u ON u.id = j.customer_id
     WHERE t.kind = 'quote_followup_48h' AND t.status = 'open' AND t.auto_emailed = 0`
  ).all();
  const { notify, shell } = require('./notify');
  for (const t of pending) {
    const to = t.user_email || t.job_email;
    if (!to) continue;
    // Only remind while the quote is still awaiting response.
    const q = await db.prepare('SELECT status FROM quotes WHERE id = ?').get(t.quote_id);
    if (!q || q.status !== 'sent') {
      await db.prepare(`UPDATE followup_tasks SET status = 'done' WHERE id = ?`).run(t.id);
      continue;
    }
    await notify({
      to,
      subject: `Still thinking about your Helpman quote? (#${t.quote_id})`,
      html: shell('A quick reminder', `Hi ${(t.name || '').split(' ')[0]}, your quote is still waiting:`, [
        ['Quote', `#${t.quote_id} — $${(t.customer_price_cents / 100).toFixed(2)}`],
        ['Next step', 'Accept it from your portal and we will schedule your project right away.'],
      ]),
    }).catch(() => {});
    await db.prepare(`UPDATE followup_tasks SET auto_emailed = 1 WHERE id = ?`).run(t.id);
    emailed.push(t.id);
  }
  return { created: created.length, emailed: emailed.length };
}

module.exports = {
  computeLeadScore, refreshLeadScore, touchInteraction, generateFollowupTasks,
  runFollowupAutomation,
  contractorLifecycle, contractorScore, retentionAtRisk,
  segmentMembers, recruitmentGaps, renderTemplate,
};
