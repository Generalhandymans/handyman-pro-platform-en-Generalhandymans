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
// Pro design: white card on soft gray, big logo, navy headlines, brand blue
// buttons, generous spacing. All dynamic values are escaped at the call site;
// `intro`/`bodyHtml` below are authored HTML (never raw user input).

const { baseUrl } = require('./magiclink');

function logoUrl() { return `${baseUrl()}/img/logo-header.jpg`; }

function brandShell(title, intro, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;padding:0;background-color:#f6f8fb;">
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 16px;">
    <div style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(16,36,63,.08);">
      <div style="padding:30px 32px 6px;text-align:center;">
        <img src="${logoUrl()}" alt="Helpman — General Handyman Solutions" style="max-width:280px;width:100%;height:auto;display:block;margin:0 auto;">
      </div>
      <div style="padding:6px 36px 10px;">
        <h2 style="color:#143d7a;font-size:22px;line-height:1.35;margin:0 0 12px;">${title}</h2>
        <div style="color:#5b6b7e;font-size:15px;line-height:1.65;margin:0 0 8px;">${intro}</div>
        ${bodyHtml || ''}
      </div>
      <div style="background:#f6f8fb;border-top:1px solid #e2e8f0;padding:16px 36px;">
        <p style="color:#8a97a5;font-size:12px;line-height:1.6;margin:0;">This is an automated notification from General Handyman Solutions. Please do not reply directly &mdash; message us from your portal instead.</p>
      </div>
    </div>
    <p style="text-align:center;color:#8a97a5;font-size:12px;margin:18px 0 0;letter-spacing:.02em;">Home projects, handled.</p>
  </div></body></html>`;
}

function btn(url, label, color) {
  return `<p style="text-align:center;margin:24px 0 8px;"><a href="${esc(url)}" style="background:${color || '#2b6fe3'};color:#ffffff;padding:13px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block;box-shadow:0 2px 6px rgba(43,111,227,.35);">${esc(label)}</a></p>`;
}

function kvRow(k, v) {
  return `<tr><td style="color:#8a97a5;font-size:13px;padding:7px 14px 7px 0;vertical-align:top;white-space:nowrap;">${esc(k)}</td><td style="font-size:14px;padding:7px 0;vertical-align:top;color:#1d2a3a;"><strong>${v}</strong></td></tr>`;
}

// The flexibility promise shown everywhere a time is communicated.
const FLEX_NOTE = 'Arrival times are approximate: your pro arrives within the window shown and confirms the day before. Thanks for keeping the schedule a little flexible.';

// "2026-11-20" -> "Thursday, November 20, 2026" for customer/contractor emails.
function prettyDay(iso) {
  try {
    const d = new Date(String(iso).slice(0, 10) + 'T12:00:00Z');
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  } catch (_) { return String(iso || ''); }
}

function flexBox() {
  return `<div style="background:#e9f1fe;border-left:4px solid #2b6fe3;border-radius:0 10px 10px 0;padding:12px 16px;margin:18px 0;"><p style="margin:0;font-size:13.5px;line-height:1.6;color:#143d7a;">&#9200; ${esc(FLEX_NOTE)}</p></div>`;
}

function techPhoto(photoUrl, size) {
  const s = size || 140;
  if (!photoUrl) return '';
  return `<div style="text-align:center;margin:20px 0 6px;"><img src="${esc(photoUrl)}" alt="Your technician" width="${s}" height="${s}" style="width:${s}px;height:${s}px;object-fit:cover;border-radius:50%;border:4px solid #e9f1fe;box-shadow:0 2px 8px rgba(16,36,63,.12);display:block;margin:0 auto;"></div>`;
}

function welcomeCustomer(name) {
  return brandShell('Welcome to Helpman!',
    `<p style="margin:0 0 12px;">Hi <strong>${esc(name)}</strong>, your account is ready.</p><p style="margin:0;">Request a service, get a fixed quote, and track everything from your portal &mdash; a verified pro, <strong>with photo</strong>, is assigned to every job.</p>`,
    btn(`${baseUrl()}/customer.html`, 'Go to my portal'));
}

function welcomeContractor(name) {
  return brandShell('Welcome aboard, pro!',
    `<p style="margin:0 0 12px;">Hi <strong>${esc(name)}</strong>, your contractor account is created and pending verification.</p><p style="margin:0;">One important step: <strong>upload your profile photo</strong> &mdash; customers see the photo of the technician assigned to their job, and we cannot offer you work until your photo is on file.</p>`,
    btn(`${baseUrl()}/contractor.html`, 'Complete my profile'));
}

// Sent when a contractor registers without a photo (which is every signup,
// since the form has no upload yet) — and re-sendable by dispatch.
function photoReminder(name) {
  return brandShell('One step left: upload your profile photo',
    `<p style="margin:0 0 12px;">Hi <strong>${esc(name)}</strong>, when we assign you a job the customer receives your <strong>name and your photo</strong> &mdash; that is how they know who is knocking on their door.</p><p style="margin:0;"><strong>Please upload your profile photo from your contractor portal.</strong> Until your photo is on file we cannot assign you any work.</p>`,
    btn(`${baseUrl()}/contractor.html`, 'Upload my photo now', '#b7791f'));
}

function quoteAcceptedCustomer(name, projectId, serviceType) {
  return brandShell(`You&apos;ve accepted your proposal &mdash; project #${esc(String(projectId))}`,
    `<p style="margin:0 0 12px;">Hi <strong>${esc(name)}</strong>, great news: your proposal for <strong>${esc(serviceType)}</strong> is accepted and your project is now in our hands.</p><p style="margin:0;"><strong>Next step:</strong> we assign a verified professional to your job. You will receive their <strong>name and photo</strong> by email as soon as they are assigned &mdash; phone numbers are never shared.</p>`,
    btn(`${baseUrl()}/customer.html`, 'Track my project'));
}

// The client-facing "your technician" email: photo + name, NO phone, NO email.
function techAssignedCustomer({ customerName, techName, photoUrl, projectId, serviceType }) {
  return brandShell(`Your technician has been assigned &mdash; project #${esc(String(projectId))}`,
    `<p style="margin:0;">Hi <strong>${esc(customerName)}</strong>, meet the professional doing your <strong>${esc(serviceType)}</strong> job:</p>`,
    `${techPhoto(photoUrl, 150)}<p style="text-align:center;font-size:19px;margin:10px 0 4px;color:#143d7a;"><strong>${esc(techName)}</strong></p>
    <p style="text-align:center;color:#8a97a5;font-size:13px;margin:0 0 8px;">Verified pro &middot; photo on file</p>
    <p style="color:#5b6b7e;font-size:14px;line-height:1.65;">You will receive the confirmed day and arrival window in a separate email. For your privacy and theirs, <strong>we never share phone numbers</strong> &mdash; message us from your portal any time.</p>`
    + btn(`${baseUrl()}/customer.html`, 'View my project'));
}

// Job-offer email to the contractor with one-click accept / decline.
function jobOfferContractor({ name, projectId, serviceType, address, budget, acceptUrl, declineUrl, expiresNote }) {
  return brandShell(`New job offer &mdash; ${esc(serviceType)} (#${esc(String(projectId))})`,
    `<p style="margin:0;">Hi <strong>${esc(name)}</strong>, General Handyman Solutions is offering you a project.${expiresNote ? ` <strong>${esc(expiresNote)}</strong>` : ''}</p>`,
    `<table style="margin:16px 0;border-collapse:collapse;" cellpadding="0" cellspacing="0"><tbody>`
    + kvRow('Project', `#${esc(String(projectId))} &mdash; ${esc(serviceType)}`)
    + kvRow('Address', esc(address))
    + kvRow('Your budget', esc(budget))
    + `</tbody></table>
    <p style="color:#5b6b7e;font-size:14px;line-height:1.65;">Answer right from this email &mdash; no login needed. Accepting means you agree to the Independent Contractor Terms.</p>
    <p style="text-align:center;margin:24px 0 8px;">
      <a href="${esc(acceptUrl)}" style="background:#1f8a4c;color:#ffffff;padding:13px 30px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block;margin:0 6px 8px 0;box-shadow:0 2px 6px rgba(31,138,76,.35);">Accept job</a>
      <a href="${esc(declineUrl)}" style="background:#ffffff;color:#143d7a;padding:11px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block;border:2px solid #e2e8f0;">Decline</a>
    </p>`);
}

// After the contractor accepts the offer: waiting for the day to be confirmed.
function offerAcceptedContractor(name, projectId, serviceType) {
  return brandShell(`Offer accepted &mdash; project #${esc(String(projectId))}`,
    `<p style="margin:0 0 12px;">Hi <strong>${esc(name)}</strong>, you accepted the <strong>${esc(serviceType)}</strong> job.</p><p style="margin:0;">It is now <strong>waiting for the day to be confirmed</strong>. As soon as dispatch confirms the visit day you will receive another email with the date and arrival window, where you confirm or decline that slot.</p>`,
    '');
}

// Day + arrival window confirmed: contractor confirms or declines the slot.
function scheduleConfirmedContractor({ name, projectId, day, window, acceptUrl, declineUrl }) {
  return brandShell(`Appointment confirmed &mdash; ${esc(prettyDay(day))} (#${esc(String(projectId))})`,
    `<p style="margin:0;">Hi <strong>${esc(name)}</strong>, your appointment is confirmed for <strong>${esc(prettyDay(day))}</strong>${window ? `, arrival window <strong>${esc(window)}</strong>` : ''}.</p>`,
    `<p style="color:#5b6b7e;font-size:14px;line-height:1.65;">Please confirm you can make it, or decline so we can reassign in time:</p>
    <p style="text-align:center;margin:24px 0 8px;">
      <a href="${esc(acceptUrl)}" style="background:#1f8a4c;color:#ffffff;padding:13px 30px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block;margin:0 6px 8px 0;box-shadow:0 2px 6px rgba(31,138,76,.35);">I confirm</a>
      <a href="${esc(declineUrl)}" style="background:#ffffff;color:#143d7a;padding:11px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block;border:2px solid #e2e8f0;">I can&apos;t make it</a>
    </p>`);
}

// Customer version: technician photo + day + window + flexibility note.
function scheduleConfirmedCustomer({ customerName, techName, photoUrl, projectId, day, window }) {
  return brandShell(`Your visit is scheduled &mdash; ${esc(prettyDay(day))} (#${esc(String(projectId))})`,
    `<p style="margin:0;">Hi <strong>${esc(customerName)}</strong>, your visit is confirmed:</p>`,
    `${techPhoto(photoUrl, 130)}
    <table style="margin:14px auto;border-collapse:collapse;" cellpadding="0" cellspacing="0"><tbody>`
    + kvRow('Technician', esc(techName))
    + kvRow('Day', esc(prettyDay(day)))
    + (window ? kvRow('Arrival window', esc(window)) : '')
    + `</tbody></table>`
    + flexBox()
    + btn(`${baseUrl()}/customer.html`, 'View my project'));
}

module.exports = { notify, shell, esc, projectParties,
  brandShell, welcomeCustomer, welcomeContractor, photoReminder,
  quoteAcceptedCustomer, techAssignedCustomer, jobOfferContractor,
  offerAcceptedContractor, scheduleConfirmedContractor, scheduleConfirmedCustomer,
  contractorPhotoUrl, prettyDay, FLEX_NOTE };
