// Marketing-email suppression list + signed unsubscribe links.
// Transactional mail (verification, quotes, notifications) is NOT affected;
// only campaigns honor the list.
'use strict';
const crypto = require('crypto');
const db = require('../db');

const SECRET = () => process.env.JWT_SECRET || 'dev-only-secret-change-me';
const norm = (e) => String(e || '').trim().toLowerCase();

function sign(email) {
  return crypto.createHmac('sha256', SECRET()).update('unsub:' + norm(email)).digest('hex');
}
function verify(email, token) {
  const a = Buffer.from(sign(email));
  const b = Buffer.from(String(token || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function link(email) {
  const base = process.env.PUBLIC_URL || 'http://localhost:3000';
  const e = Buffer.from(norm(email)).toString('base64url');
  return `${base}/api/unsubscribe?e=${e}&t=${sign(email)}`;
}
function decodeEmail(e) {
  try { return norm(Buffer.from(String(e || ''), 'base64url').toString('utf8')); } catch (_) { return ''; }
}

async function isSuppressed(email) {
  return !!(await db.prepare('SELECT email FROM email_suppressions WHERE email = ?').get(norm(email)));
}
async function suppress(email, reason) {
  const sql = db._isPg
    ? 'INSERT INTO email_suppressions (email, reason) VALUES (?,?) ON CONFLICT (email) DO NOTHING RETURNING email'
    : 'INSERT OR IGNORE INTO email_suppressions (email, reason) VALUES (?,?)';
  await db.prepare(sql).run(norm(email), reason || 'unsubscribed');
}

// Footer required on every campaign: opt-out link + sender's postal address.
function footerHtml(email) {
  const addr = process.env.COMPANY_POSTAL_ADDRESS || '';
  return `<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 12px;">
<p style="color:#94a3b8;font-size:12px;line-height:1.5;">
${addr ? addr.replace(/</g, '&lt;') + '<br>' : ''}
You are receiving this because you requested a quote or created an account.
<a href="${link(email)}">Unsubscribe</a> from promotional emails.</p>`;
}

module.exports = { sign, verify, link, decodeEmail, norm, isSuppressed, suppress, footerHtml };
