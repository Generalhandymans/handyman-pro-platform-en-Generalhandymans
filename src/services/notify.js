// Transactional notifications: status-change emails sent through the pluggable
// mailer. Every attempt is recorded in email_log (the mailer's contract), so
// in console/log mode nothing is really delivered but everything is auditable.
// Sender identity is ALWAYS the business account (mailer module default).
const db = require('../db');
const mailer = require('./mailer');

async function logEmail(to, subject, status, provider) {
  await db.prepare(
    'INSERT INTO email_log (outbox_id, to_email, subject, status, provider) VALUES (NULL,?,?,?,?)'
  ).run(to, subject, status, provider);
}

async function notify({ to, subject, html }) {
  if (!to) return { ok: false, skipped: 'no recipient' };
  let result;
  try {
    result = await mailer.send({ to, subject, html });
  } catch (e) {
    result = { ok: false, provider: mailer.activeProvider(), error: String(e.message).slice(0, 200) };
  }
  try {
    await logEmail(to, subject, result.ok ? 'sent' : 'failed', result.provider || mailer.activeProvider());
  } catch (e) { /* logging must never break the request */ }
  return result;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function shell(title, intro, rows) {
  const rowHtml = (rows || []).map(([k, v]) =>
    `<tr><td style="color:#64748b;padding:6px 12px 6px 0;">${esc(k)}</td><td style="padding:6px 0;"><strong>${esc(v)}</strong></td></tr>`
  ).join('');
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#15202b;max-width:560px;margin:0 auto;padding:24px;">
    <div style="font-weight:900;font-size:20px;margin-bottom:4px;">🛠 Handyman <em>Pro</em></div>
    <h2 style="margin:8px 0 4px;">${esc(title)}</h2>
    <p style="color:#475569;">${esc(intro)}</p>
    ${rowHtml ? `<table>${rowHtml}</table>` : ''}
    <p style="color:#94a3b8;font-size:12px;margin-top:24px;">This is an automated notification from Helpman. Please do not reply directly — message us from your portal instead.</p>
  </body></html>`;
}

// Look up the people involved in a project for notifications.
async function projectParties(projectId) {
  const p = await db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!p) return {};
  const job = await db.prepare('SELECT * FROM job_requests WHERE id = ?').get(p.job_request_id);
  const customer = job && (job.customer_id
    ? await db.prepare('SELECT name, email FROM users WHERE id = ?').get(job.customer_id)
    : (job.email ? { name: job.name, email: job.email } : null));
  const contractor = p.contractor_id
    ? await db.prepare('SELECT u.name, u.email FROM contractors c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(p.contractor_id)
    : null;
  const admins = await db.prepare("SELECT name, email FROM users WHERE role = 'admin'").all();
  return { project: p, job, customer, contractor, admins };
}

module.exports = { notify, shell, esc, projectParties };
