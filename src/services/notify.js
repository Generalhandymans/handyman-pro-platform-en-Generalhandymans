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
    <div style="font-weight:900;font-size:20px;margin-bottom:2px;letter-spacing:0.04em;">HELPMAN</div>
    <div style="color:#64748b;font-size:12px;margin-bottom:4px;">Home projects, handled.</div>
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

// ---------------------------------------------------------------------------
// Lifecycle emails (2026-10-07): the full notification chain of a project.
// All transactional — they go through notify() (console log until SendGrid
// is configured). Each is idempotent by nature (called once per event).
// ---------------------------------------------------------------------------
const SITE = () => (process.env.PUBLIC_URL || 'https://helpman.app').replace(/\/$/, '');

async function depositConfirmationEmail(projectId) {
  const { project, job, customer } = await projectParties(projectId);
  if (!project || !customer || !customer.email) return;
  const dep = await db.prepare(
    `SELECT amount_cents, provider FROM payments WHERE project_id = ? AND kind = 'deposit' AND status IN ('paid','recorded') ORDER BY id DESC LIMIT 1`
  ).get(projectId);
  await notify({
    to: customer.email,
    subject: `Deposit received — project #${project.id} ✓`,
    html: shell('Deposit received ✓', `Hi ${(customer.name || '').split(' ')[0]}, your deposit is confirmed:`, [
      ['Project', `#${project.id} — ${job.service_type}`],
      ['Amount paid', '$' + ((dep ? dep.amount_cents : project.expected_deposit) / 100).toFixed(2)],
      ['Method', dep && dep.provider === 'stripe' ? 'Card (Stripe)' : dep && dep.provider === 'simulated' ? 'Simulated (test)' : 'Manual'],
      ['Terms of Service', `${SITE()}/terms.html`],
      ['Next step', 'We assign your professional and notify you with the scheduled date.'],
    ]),
  }).catch(() => {});
}

async function contractorAcceptanceEmail(projectId) {
  const { project, job, contractor } = await projectParties(projectId);
  if (!project || !contractor || !contractor.email) return;
  await notify({
    to: contractor.email,
    subject: `You accepted project #${project.id} ✓`,
    html: shell('Job accepted ✓', `Hi ${contractor.name.split(' ')[0]}, you accepted this job under the Independent Contractor Terms:`, [
      ['Project', `#${project.id} — ${job.service_type}`],
      ['Your payout', '$' + (project.contractor_cost_cents / 100).toFixed(2)],
      ['Independent Contractor Terms', `${SITE()}/contractor-terms.html`],
      ['Reminder', 'No direct contact with the customer — all communication goes through Helpman support.'],
    ]),
  }).catch(() => {});
}

async function scheduleNotificationEmails(projectId) {
  const { project, job, customer, contractor } = await projectParties(projectId);
  if (!project || !project.scheduled_start) return;
  const dates = project.scheduled_start + (project.scheduled_end && project.scheduled_end !== project.scheduled_start ? ` → ${project.scheduled_end}` : '');
  const addr = [job.address, job.city, job.state, job.zip].filter(Boolean).join(', ');
  if (customer && customer.email) {
    await notify({
      to: customer.email,
      subject: `Your job is approved for ${project.scheduled_start} — project #${project.id}`,
      html: shell('Job approved ✓', 'Your work is approved and scheduled:', [
        ['Project', `#${project.id} — ${job.service_type}`],
        ['Date', dates],
        ['Professional coming', contractor ? contractor.name : 'Assigned pro'],
        ['Address', addr || '—'],
      ]),
    }).catch(() => {});
  }
  if (contractor && contractor.email) {
    await notify({
      to: contractor.email,
      subject: `Scheduled: project #${project.id} — ${project.scheduled_start}`,
      html: shell('You are scheduled 📅', `Hi ${contractor.name.split(' ')[0]}, this job is scheduled:`, [
        ['Project', `#${project.id} — ${job.service_type}`],
        ['Date', dates],
        ['Address', addr || '—'],
        ['Customer', customer ? customer.name : '—'],
        ['Reminder', 'Print the close-out sheet, have the customer sign it, and upload photos of the finished work + the signed sheet.'],
      ]),
    }).catch(() => {});
  }
}

async function completionEmails(projectId) {
  const { project, job, customer, contractor } = await projectParties(projectId);
  if (!project) return;
  if (customer && customer.email) {
    await notify({
      to: customer.email,
      subject: `Your project is complete (#${project.id}) 🎉`,
      html: shell('Project completed', 'Your project is complete. Please leave a review from your portal:', [
        ['Project', `#${project.id} — ${job.service_type}`],
        ['Address', job.address],
      ]),
    }).catch(() => {});
  }
  if (contractor && contractor.email) {
    await notify({
      to: contractor.email,
      subject: `Project #${project.id} closed — thanks!`,
      html: shell('Job closed ✓', `Hi ${contractor.name.split(' ')[0]}, this job is marked complete:`, [
        ['Project', `#${project.id} — ${job.service_type}`],
        ['Payout', '$' + (project.contractor_cost_cents / 100).toFixed(2)],
        ['Next step', 'Watch your portal for the next offer.'],
      ]),
    }).catch(() => {});
  }
}

module.exports.depositConfirmationEmail = depositConfirmationEmail;
module.exports.contractorAcceptanceEmail = contractorAcceptanceEmail;
module.exports.scheduleNotificationEmails = scheduleNotificationEmails;
module.exports.completionEmails = completionEmails;
