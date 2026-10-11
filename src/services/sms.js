// SMS: appointment confirmation, day-before reminder, "technician is on the way".
// Provider: 'console' (default: logged, nothing sent) or 'twilio' (set TWILIO_ACCOUNT_SID,
// TWILIO_AUTH_TOKEN and TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID).
// RULES BAKED IN: a text goes out ONLY to a phone with recorded consent; STOP opts out at once;
// reminders respect a daytime window in the BUSINESS time zone; the technician's own number is
// never shared (mediated contact). The Twilio calls were written against its public REST API and
// are NOT exercised against the live service in this repo's tests.
'use strict';
const crypto = require('crypto');
const db = require('../db');

const BRAND = () => process.env.BRAND_NAME || 'Helpman';
const TZ = () => process.env.BUSINESS_TZ || 'America/Los_Angeles';
const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const START_WORDS = new Set(['START', 'YES', 'UNSTOP']);

// ---------- pure helpers (unit-tested) ----------
function normalizePhone(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  if (s.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? '+' + digits : null;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return null;
}
function partsIn(tz, now) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  return Object.fromEntries(f.formatToParts(now).map(p => [p.type, p.value]));
}
// 'YYYY-MM-DD' of the day after `now`, as seen in `tz`.
function tomorrowIn(tz, now = new Date()) {
  const p = partsIn(tz, now);
  const d = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + 1));
  return d.toISOString().slice(0, 10);
}
const localHour = (tz, now = new Date()) => Number(partsIn(tz, now).hour);
// Texting people at night is both rude and (in the US) restricted: stay inside 9:00–19:00 local.
const inSendWindow = (tz, now = new Date(), from = 9, to = 19) => { const h = localHour(tz, now); return h >= from && h < to; };
const prettyDate = (iso) => new Date(String(iso).slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

// Twilio webhook signature: base64(HMAC-SHA1(token, url + each param name+value, params sorted by name)).
function twilioSignature(url, params, token) {
  const data = url + Object.keys(params || {}).sort().map(k => k + params[k]).join('');
  return crypto.createHmac('sha1', token).update(data).digest('base64');
}
function verifyTwilio(url, params, signature, token) {
  const a = Buffer.from(twilioSignature(url, params, token));
  const b = Buffer.from(String(signature || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const keywordOf = (body) => String(body || '').trim().toUpperCase();

// ---------- delivery ----------
const provider = () => (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN &&
  (process.env.TWILIO_FROM || process.env.TWILIO_MESSAGING_SERVICE_SID) ? 'twilio' : 'console');

async function deliver({ to, body }) {
  if (provider() === 'console') { console.log(`[sms:console] to ${to}: ${body}`); return { provider: 'console' }; }
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const form = new URLSearchParams({ To: to, Body: body });
  if (process.env.TWILIO_MESSAGING_SERVICE_SID) form.set('MessagingServiceSid', process.env.TWILIO_MESSAGING_SERVICE_SID);
  else form.set('From', process.env.TWILIO_FROM);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  if (!res.ok) throw new Error('Twilio responded ' + res.status);
  const j = await res.json().catch(() => ({}));
  return { provider: 'twilio', ref: j.sid };
}

// ---------- consent ----------
async function hasConsent(phone) {
  const r = await db.prepare('SELECT opted_in FROM sms_consents WHERE phone = ?').get(phone);
  return !!(r && r.opted_in);
}
async function setConsent(phone, optedIn, source) {
  const e = normalizePhone(phone);
  if (!e) return false;
  const sql = db._isPg
    ? `INSERT INTO sms_consents (phone, opted_in, source, updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT (phone) DO UPDATE SET opted_in = EXCLUDED.opted_in, source = EXCLUDED.source, updated_at = CURRENT_TIMESTAMP RETURNING phone`
    : `INSERT INTO sms_consents (phone, opted_in, source, updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(phone) DO UPDATE SET opted_in = excluded.opted_in, source = excluded.source, updated_at = CURRENT_TIMESTAMP`;
  await db.prepare(sql).run(e, optedIn ? 1 : 0, source || null);
  return true;
}

// ---------- sending (consent-gated, always logged) ----------
async function log(row) {
  await db.prepare('INSERT INTO sms_log (to_phone, body, kind, project_id, status, provider, error) VALUES (?,?,?,?,?,?,?)')
    .run(row.to, row.body, row.kind || null, row.projectId || null, row.status, row.provider || provider(), row.error || null);
}
async function send({ phone, body, kind, projectId }) {
  const to = normalizePhone(phone);
  if (!to) { await log({ to: String(phone || ''), body, kind, projectId, status: 'skipped_bad_number' }); return { sent: false, reason: 'bad_number' }; }
  if (!(await hasConsent(to))) { await log({ to, body, kind, projectId, status: 'skipped_no_consent' }); return { sent: false, reason: 'no_consent' }; }
  try {
    const r = await deliver({ to, body });
    await log({ to, body, kind, projectId, status: 'sent', provider: r.provider });
    return { sent: true, provider: r.provider };
  } catch (e) {
    await log({ to, body, kind, projectId, status: 'failed', error: String(e.message).slice(0, 300) });
    return { sent: false, reason: 'failed' };
  }
}

// The customer's phone numbers for a project: the request's phone, then the account's. First with consent wins.
async function textCustomer(projectId, kind, body) {
  const row = await db.prepare(
    `SELECT j.phone AS job_phone, u.phone AS user_phone FROM projects p
     JOIN job_requests j ON j.id = p.job_request_id LEFT JOIN users u ON u.id = j.customer_id WHERE p.id = ?`
  ).get(projectId);
  if (!row) return { sent: false, reason: 'no_project' };
  const candidates = [row.job_phone, row.user_phone].map(normalizePhone).filter(Boolean);
  for (const ph of [...new Set(candidates)]) if (await hasConsent(ph)) return send({ phone: ph, body, kind, projectId });
  return send({ phone: candidates[0] || row.job_phone, body, kind, projectId }); // logs skipped_no_consent
}

// ---------- templates (short; the STOP line is required) ----------
const STOP_LINE = ' Reply STOP to opt out.';
const T = {
  scheduled: (service, date) => `${BRAND()}: your ${service} visit is scheduled for ${prettyDate(date)}.${STOP_LINE}`,
  reminder: (service, date) => `${BRAND()} reminder: your ${service} visit is tomorrow, ${prettyDate(date)}.${STOP_LINE}`,
  missed: () => `${BRAND()}: we missed you at today's visit. Please reply to our email or open your portal to pick a new time.${STOP_LINE}`,
  onTheWay: (first, service) => `${BRAND()}: ${first} is on the way for your ${service} visit.${STOP_LINE}`,
};

// ---------- the day-before reminder job ----------
async function runReminders({ now = new Date(), force = false } = {}) {
  const tz = TZ();
  if (!force && !inSendWindow(tz, now)) return { skipped: 'outside the daytime send window', sent: 0, checked: 0 };
  const tomorrow = tomorrowIn(tz, now);
  const rows = (await db.prepare(
    `SELECT p.id, p.scheduled_start, j.service_type FROM projects p
     JOIN job_requests j ON j.id = p.job_request_id
     WHERE p.stage IN ('assigned','scheduled') AND p.reminder_sent_at IS NULL AND p.scheduled_start IS NOT NULL`
  ).all()).filter(r => String(r.scheduled_start).slice(0, 10) === tomorrow);
  let sent = 0;
  for (const r of rows) {
    // Atomic claim: two instances (or two clicks) cannot remind the same visit twice.
    const claim = await db.prepare('UPDATE projects SET reminder_sent_at = CURRENT_TIMESTAMP WHERE id = ? AND reminder_sent_at IS NULL').run(r.id);
    if (claim.changes !== 1) continue;
    const out = await textCustomer(r.id, 'reminder', T.reminder(r.service_type, r.scheduled_start));
    if (out.sent) sent++;
    else if (out.reason === 'failed') await db.prepare('UPDATE projects SET reminder_sent_at = NULL WHERE id = ?').run(r.id); // retry next run
  }
  return { sent, checked: rows.length, for_date: tomorrow };
}

module.exports = {
  STOP_WORDS, START_WORDS, normalizePhone, tomorrowIn, localHour, inSendWindow, prettyDate, twilioSignature, verifyTwilio, keywordOf,
  provider, deliver, hasConsent, setConsent, send, textCustomer, runReminders, T,
};
