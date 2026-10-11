// Signed, expiring magic links: lets a contractor answer a job offer or a
// confirmed schedule straight from an email, without logging in.
// Format: base64url(JSON payload + exp) + "." + HMAC-SHA256(secret, "magic:"+body).
// The payload must include a per-use random nonce (jti) so a token cannot be
// forged for a different project/contractor/purpose.
'use strict';
const crypto = require('crypto');

const SECRET = () => process.env.JWT_SECRET || 'dev-only-secret-change-me';

function sign(payload, ttlMs) {
  const body = Buffer.from(JSON.stringify({
    ...payload,
    jti: crypto.randomBytes(16).toString('hex'),
    exp: Date.now() + ttlMs,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET()).update('magic:' + body).digest('base64url');
  return `${body}.${sig}`;
}

// Returns the payload object, or null when the signature is bad or it expired.
function verify(token) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const want = crypto.createHmac('sha256', SECRET()).update('magic:' + body).digest('base64url');
    const a = Buffer.from(want);
    const b = Buffer.from(sig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

const baseUrl = () => process.env.PUBLIC_URL || 'https://helpman.app';

module.exports = { sign, verify, baseUrl };
