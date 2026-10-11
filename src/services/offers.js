// Job-offer + schedule-confirmation flow over magic links.
// A contractor answers straight from the email (no login needed); the signed
// token carries { purpose, projectId, contractorId } and expires.
// The portal endpoints in routes/projects.js reuse the same core functions.
'use strict';
const db = require('../db');
const magic = require('./magiclink');
const { auditLog } = require('./audit');
const { touchInteraction } = require('./crm');
const { CONTRACTOR_TERMS_VERSION, recordAcceptance } = require('./terms');
const {
  notify, esc, contractorPhotoUrl, techAssignedCustomer, jobOfferContractor,
  offerAcceptedContractor, scheduleConfirmedContractor, scheduleConfirmedCustomer,
} = require('./notify');

const OFFER_TTL_MS = 24 * 60 * 60 * 1000; // 24 h to answer an offer
const SCHEDULE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h to confirm a scheduled day

function offerLinks(projectId, contractorId) {
  const token = magic.sign({ purpose: 'offer', projectId, contractorId }, OFFER_TTL_MS);
  const base = magic.baseUrl();
  return {
    token,
    acceptUrl: `${base}/offer.html?t=${token}&a=1`,
    declineUrl: `${base}/offer.html?t=${token}&a=0`,
  };
}

function scheduleLinks(projectId, contractorId) {
  const token = magic.sign({ purpose: 'schedule', projectId, contractorId }, SCHEDULE_TTL_MS);
  const base = magic.baseUrl();
  return {
    token,
    acceptUrl: `${base}/offer.html?st=${token}&a=1`,
    declineUrl: `${base}/offer.html?st=${token}&a=0`,
  };
}

// Release offers nobody answered in time; notify dispatch to reassign.
async function releaseExpiredOffers() {
  const now = new Date().toISOString();
  const stale = await db.prepare(
    `SELECT id FROM projects WHERE contractor_status = 'offered' AND offer_expires_at IS NOT NULL AND offer_expires_at < ?`
  ).all(now);
  for (const s of stale) {
    const p = await db.prepare('SELECT * FROM projects WHERE id = ?').get(s.id);
    if (!p || p.contractor_status !== 'offered') continue;
    await db.prepare(
      `UPDATE projects SET contractor_id = NULL, contractor_status = NULL, offer_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND contractor_status = 'offered'`
    ).run(p.id);
    await auditLog(null, 'project.offer_expired', 'projects', p.id, 'Offer expired without an answer; released for reassignment');
    const job = await db.prepare('SELECT service_type FROM job_requests WHERE id = ?').get(p.job_request_id);
    const admins = await db.prepare("SELECT email FROM users WHERE role = 'admin'").all();
    for (const a of admins) {
      await notify({
        to: a.email,
        subject: `Offer expired — project #${p.id} needs a contractor`,
        html: `<p>The 24-hour job offer for project #${p.id} (${esc(job ? job.service_type : '')}) expired with no answer. Please assign another professional.</p>`,
      }).catch(() => {});
    }
  }
  return stale.length;
}

async function partiesFor(p) {
  const job = await db.prepare('SELECT * FROM job_requests WHERE id = ?').get(p.job_request_id);
  const cust = job && job.customer_id
    ? await db.prepare('SELECT name, email FROM users WHERE id = ?').get(job.customer_id)
    : (job ? { name: job.name, email: job.email } : null);
  const cont = p.contractor_id
    ? await db.prepare('SELECT c.*, u.name AS user_name, u.email AS user_email FROM contractors c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(p.contractor_id)
    : null;
  return { job, cust, cont };
}

// ---- Accept a job offer (portal or magic link) ----
async function acceptOffer(p, { userId, ip }) {
  const { job, cust, cont } = await partiesFor(p);
  await db.prepare(
    `UPDATE projects SET contractor_status = 'accepted', stage = 'scheduled', offer_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(p.id);
  await db.prepare(`UPDATE job_requests SET status = 'assigned', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(p.job_request_id);
  await recordAcceptance({ userId, kind: 'contractor_job', referenceId: p.id, version: CONTRACTOR_TERMS_VERSION, ip: ip || null });
  await auditLog(userId, 'project.contractor_accepted', 'projects', p.id, `Contractor accepted under terms v${CONTRACTOR_TERMS_VERSION}`);
  await touchInteraction(p.job_request_id, 'contractor_reply', 'offer accepted');

  // Contractor: accepted — now waiting for the day to be confirmed.
  if (cont && cont.user_email) {
    await notify({
      to: cont.user_email,
      subject: `Offer accepted — project #${p.id} (waiting for day confirmation)`,
      html: offerAcceptedContractor(cont.user_name.split(' ')[0], p.id, job.service_type),
    }).catch(() => {});
  }
  // Customer: meet your technician — photo + name, never the phone.
  const custEmail = cust && cust.email;
  if (custEmail) {
    await notify({
      to: custEmail,
      subject: `Your technician has been assigned — project #${p.id}`,
      html: techAssignedCustomer({
        customerName: String(cust.name || 'there').split(' ')[0],
        techName: cont ? cont.user_name : 'Assigned pro',
        photoUrl: cont ? contractorPhotoUrl(cont) : null,
        projectId: p.id,
        serviceType: job.service_type,
      }),
    }).catch(() => {});
  }
  return await db.prepare('SELECT * FROM projects WHERE id = ?').get(p.id);
}

// ---- Decline a job offer (portal or magic link) ----
async function declineOffer(p, { userId }) {
  const { job } = await partiesFor(p);
  await db.prepare(
    `UPDATE projects SET contractor_id = NULL, contractor_status = NULL, offer_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(p.id);
  await auditLog(userId, 'project.contractor_declined', 'projects', p.id, 'Contractor declined the offer');
  const admins = await db.prepare("SELECT email FROM users WHERE role = 'admin'").all();
  for (const a of admins) {
    await notify({
      to: a.email,
      subject: `Contractor declined project #${p.id}`,
      html: `<p>The contractor declined the job offer for project #${p.id} (${esc(job ? job.service_type : '')}). Please assign another professional.</p>`,
    }).catch(() => {});
  }
  await touchInteraction(p.job_request_id, 'contractor_reply', 'offer declined');
  return { accepted: false };
}

// ---- Validate a magic token and load the matching project/contractor ----
async function loadByToken(token, purpose) {
  const payload = magic.verify(token);
  if (!payload || payload.purpose !== purpose) return { error: 'invalid' };
  const p = await db.prepare('SELECT * FROM projects WHERE id = ?').get(payload.projectId);
  if (!p || p.contractor_id !== payload.contractorId) return { error: 'invalid' };
  return { payload, project: p };
}

// ---- Contractor confirms / declines the scheduled day + window ----
async function respondToSchedule(p, { accept, contractorUserId }) {
  if (p.schedule_status !== 'pending') {
    return { error: 'This schedule is no longer awaiting confirmation.' };
  }
  const { job, cont } = await partiesFor(p);
  if (accept) {
    await db.prepare(
      `UPDATE projects SET schedule_status = 'confirmed', schedule_token = NULL, schedule_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(p.id);
    await auditLog(contractorUserId || null, 'project.schedule_confirmed', 'projects', p.id, `Contractor confirmed ${p.scheduled_start || ''} ${p.arrival_window || ''}`);
    return { confirmed: true };
  }
  await db.prepare(
    `UPDATE projects SET schedule_status = 'declined', schedule_token = NULL, schedule_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(p.id);
  await auditLog(contractorUserId || null, 'project.schedule_declined', 'projects', p.id, 'Contractor declined the scheduled slot');
  const admins = await db.prepare("SELECT email FROM users WHERE role = 'admin'").all();
  for (const a of admins) {
    await notify({
      to: a.email,
      subject: `Contractor declined the schedule — project #${p.id}`,
      html: `<p>${esc(cont ? cont.user_name : 'The contractor')} declined the ${esc(p.scheduled_start || '')} slot for project #${p.id} (${esc(job ? job.service_type : '')}). Please pick a new day.</p>`,
    }).catch(() => {});
  }
  return { confirmed: false };
}

// ---- Send the day-confirmation emails (contractor + customer) ----
async function sendScheduleConfirmation(p) {
  const { job, cust, cont } = await partiesFor(p);
  if (!cont) return;
  const day = p.scheduled_start ? String(p.scheduled_start).slice(0, 10) : '';
  const links = scheduleLinks(p.id, cont.id);
  const expiresAt = new Date(Date.now() + SCHEDULE_TTL_MS).toISOString();
  await db.prepare(`UPDATE projects SET schedule_status = 'pending', schedule_token = ?, schedule_expires_at = ? WHERE id = ?`)
    .run(links.token, expiresAt, p.id);

  if (cont.user_email) {
    await notify({
      to: cont.user_email,
      subject: `Appointment confirmed — ${day} (#${p.id})`,
      html: scheduleConfirmedContractor({
        name: cont.user_name.split(' ')[0], projectId: p.id, day,
        window: p.arrival_window || '',
        acceptUrl: links.acceptUrl, declineUrl: links.declineUrl,
      }),
    }).catch(() => {});
  }
  const custEmail = cust && cust.email;
  if (custEmail) {
    await notify({
      to: custEmail,
      subject: `Your visit is scheduled — ${day} (#${p.id})`,
      html: scheduleConfirmedCustomer({
        customerName: String(cust.name || 'there').split(' ')[0],
        techName: cont.user_name,
        photoUrl: contractorPhotoUrl(cont),
        projectId: p.id, day, window: p.arrival_window || '',
      }),
    }).catch(() => {});
  }
}

module.exports = {
  offerLinks, scheduleLinks, releaseExpiredOffers,
  acceptOffer, declineOffer, loadByToken, respondToSchedule, sendScheduleConfirmation,
  OFFER_TTL_MS, SCHEDULE_TTL_MS,
};
