// Transactional notifications: status-change emails sent through the pluggable
// mailer. Every attempt is recorded in email_log (the mailer's contract), so
// in console/log mode nothing is really delivered but everything is auditable.
// Sender identity is ALWAYS the business account (mailer module default).
const db = require('../db');
const mailer = require('./mailer');
const BRAND = process.env.BRAND_NAME || 'Helpman';

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
    <div style="font-weight:900;font-size:20px;margin-bottom:4px;">🛠 ${esc(BRAND)}</div>
    <h2 style="margin:8px 0 4px;">${esc(title)}</h2>
    <p style="color:#475569;">${esc(intro)}</p>
    ${rowHtml ? `<table>${rowHtml}</table>` : ''}
    <p style="color:#94a3b8;font-size:12px;margin-top:24px;">This is an automated notification from General Handyman Solutions. Please do not reply directly — message us from your portal instead.</p>
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

// Public token-capability URL of a contractor's profile photo (for emails).
function contractorPhotoUrl(c) {
  if (!c || !c.photo_filename) return null;
  return `${baseUrl()}/api/contractor-photos/${c.photo_filename}`;
}

// ---------- Branded lifecycle emails (contractor photo + schedule flow) ----------

const { baseUrl } = require('./magiclink');

function logoUrl() { return `${baseUrl()}/img/logo-header.jpg`; }

// Branded shell: logo on top, then title/intro/body, then the standard footer.
function brandShell(title, intro, bodyHtml) {
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#15202b;max-width:560px;margin:0 auto;padding:24px;">
    <div style="text-align:center;margin-bottom:12px;"><img src="${logoUrl()}" alt="${esc(BRAND)}" style="max-width:220px;height:auto;"></div>
    <h2 style="margin:8px 0 4px;">${esc(title)}</h2>
    <p style="color:#475569;">${esc(intro)}</p>
    ${bodyHtml || ''}
    <p style="color:#94a3b8;font-size:12px;margin-top:24px;">This is an automated notification from General Handyman Solutions. Please do not reply directly — message us from your portal instead.</p>
  </body></html>`;
}

function btn(url, label, color) {
  return `<p style="text-align:center;margin:20px 0;"><a href="${esc(url)}" style="background:${color || '#111827'};color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;">${esc(label)}</a></p>`;
}

// The flexibility promise shown everywhere a time is communicated.
const FLEX_NOTE = 'Arrival times are approximate: your pro arrives within the window shown and confirms the day before. Thanks for keeping the schedule a little flexible.';

function welcomeCustomer(name) {
  return brandShell('Welcome to Helpman!',
    `Hi ${name}, your account is ready. Request a service, get a fixed quote, and track everything from your portal — a verified pro, with photo, is assigned to every job.`,
    btn(`${baseUrl()}/customer.html`, 'Go to my portal', '#2563eb'));
}

function welcomeContractor(name) {
  return brandShell('Welcome aboard, pro!',
    `Hi ${name}, your contractor account is created and pending verification. One important step: upload your profile photo — customers see the photo of the technician assigned to their job, and we cannot offer you work until your photo is on file.`,
    btn(`${baseUrl()}/contractor.html`, 'Complete my profile', '#2563eb'));
}

// Sent when a contractor registers without a photo (which is every signup,
// since the form has no upload yet) — and re-sendable by dispatch.
function photoReminder(name) {
  return brandShell('One step left: upload your profile photo',
    `Hi ${name}, when we assign you a job the customer receives your name and your photo — that is how they know who is knocking on their door.`,
    `<p><strong>Please upload your profile photo from your contractor portal.</strong> Until your photo is on file we cannot assign you any work.</p>`
    + btn(`${baseUrl()}/contractor.html`, 'Upload my photo now', '#d97706'));
}

function quoteAcceptedCustomer(name, projectId, serviceType) {
  return brandShell(`You've accepted your proposal — project #${projectId}`,
    `Hi ${name}, great news: your proposal for <strong>${serviceType}</strong> is accepted and your project is now in our hands.`,
    `<p>Next step: we assign a verified professional to your job. You will receive their <strong>name and photo</strong> by email as soon as they are assigned — no phone numbers are ever shared.</p>`
    + btn(`${baseUrl()}/customer.html`, 'Track my project', '#2563eb'));
}

// The client-facing "your technician" email: photo + name, NO phone, NO email.
function techAssignedCustomer({ customerName, techName, photoUrl, projectId, serviceType }) {
  const img = photoUrl
    ? `<div style="text-align:center;margin:16px 0;"><img src="${photoUrl}" alt="Your technician" style="width:140px;height:140px;object-fit:cover;border-radius:50%;border:3px solid #e2e8f0;"></div>`
    : '';
  return brandShell(`Your technician has been assigned — project #${projectId}`,
    `Hi ${customerName}, meet the professional doing your <strong>${serviceType}</strong> job:`,
    `${img}<p style="text-align:center;font-size:18px;"><strong>${techName}</strong></p>`
    + `<p>You will receive the confirmed day and arrival window in a separate email. For your privacy and theirs, we never share phone numbers — message us from your portal any time.</p>`
    + btn(`${baseUrl()}/customer.html`, 'View my project', '#2563eb'));
}

// Job-offer email to the contractor with one-click accept / decline.
function jobOfferContractor({ name, projectId, serviceType, address, budget, acceptUrl, declineUrl, expiresNote }) {
  return brandShell(`New job offer — ${serviceType} (#${projectId})`,
    `Hi ${name}, General Handyman Solutions is offering you a project. ${expiresNote || ''}`,
    `<table>
      <tr><td style="color:#64748b;padding:6px 12px 6px 0;">Project</td><td><strong>#${projectId} — ${serviceType}</strong></td></tr>
      <tr><td style="color:#64748b;padding:6px 12px 6px 0;">Address</td><td><strong>${address}</strong></td></tr>
      <tr><td style="color:#64748b;padding:6px 12px 6px 0;">Your budget</td><td><strong>${budget}</strong></td></tr>
    </table>
    <p>Answer right from this email — no login needed. Accepting means you agree to the Independent Contractor Terms.</p>`
    + `<p style="text-align:center;margin:20px 0;">
        <a href="${acceptUrl}" style="background:#16a34a;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;margin-right:8px;">Accept job</a>
        <a href="${declineUrl}" style="background:#fff;color:#111827;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;border:2px solid #e2e8f0;">Decline</a>
      </p>`);
}

// After the contractor accepts the offer: waiting for the day to be confirmed.
function offerAcceptedContractor(name, projectId, serviceType) {
  return brandShell(`Offer accepted — project #${projectId}`,
    `Hi ${name}, you accepted the <strong>${serviceType}</strong> job. It is now <strong>waiting for the day to be confirmed</strong>.`,
    `<p>As soon as dispatch confirms the visit day you will receive another email with the date and arrival window, where you confirm or decline that slot.</p>`);
}

// Day + arrival window confirmed: contractor confirms or declines the slot.
function scheduleConfirmedContractor({ name, projectId, day, window, acceptUrl, declineUrl }) {
  return brandShell(`Appointment confirmed — ${day} (#${projectId})`,
    `Hi ${name}, your appointment is confirmed for <strong>${day}</strong>${window ? `, arrival window <strong>${window}</strong>` : ''}.`,
    `<p>Please confirm you can make it, or decline so we can reassign in time:</p>`
    + `<p style="text-align:center;margin:20px 0;">
        <a href="${acceptUrl}" style="background:#16a34a;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;margin-right:8px;">I confirm</a>
        <a href="${declineUrl}" style="background:#fff;color:#111827;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;border:2px solid #e2e8f0;">I can't make it</a>
      </p>`);
}

// Customer version: technician photo + day + window + flexibility note.
function scheduleConfirmedCustomer({ customerName, techName, photoUrl, projectId, day, window }) {
  const img = photoUrl
    ? `<div style="text-align:center;margin:16px 0;"><img src="${photoUrl}" alt="Your technician" style="width:140px;height:140px;object-fit:cover;border-radius:50%;border:3px solid #e2e8f0;"></div>`
    : '';
  return brandShell(`Your visit is scheduled — ${day} (#${projectId})`,
    `Hi ${customerName}, your visit is confirmed:`,
    `${img}
    <table>
      <tr><td style="color:#64748b;padding:6px 12px 6px 0;">Technician</td><td><strong>${techName}</strong></td></tr>
      <tr><td style="color:#64748b;padding:6px 12px 6px 0;">Day</td><td><strong>${day}</strong></td></tr>
      ${window ? `<tr><td style="color:#64748b;padding:6px 12px 6px 0;">Arrival window</td><td><strong>${window}</strong></td></tr>` : ''}
    </table>
    <p style="background:#f8fafc;border-left:4px solid #2563eb;padding:10px 14px;">${FLEX_NOTE}</p>`
    + btn(`${baseUrl()}/customer.html`, 'View my project', '#2563eb'));
}

module.exports = { notify, shell, esc, projectParties,
  brandShell, welcomeCustomer, welcomeContractor, photoReminder,
  quoteAcceptedCustomer, techAssignedCustomer, jobOfferContractor,
  offerAcceptedContractor, scheduleConfirmedContractor, scheduleConfirmedCustomer,
  contractorPhotoUrl, FLEX_NOTE };
