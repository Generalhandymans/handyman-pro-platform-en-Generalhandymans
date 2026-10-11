// Two-step verification (TOTP, RFC 6238) with no external dependency, plus
// one-time recovery codes. Compatible with Google Authenticator, Authy,
// 1Password, Microsoft Authenticator (SHA-1, 6 digits, 30 s).
'use strict';
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function hotp(secretBuf, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secretBuf).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}
const stepOf = (ms) => Math.floor(ms / 1000 / STEP);
const codeAt = (secretB32, ms, digits = 6) => hotp(base32Decode(secretB32), stepOf(ms), digits);

// Accepts the current step and one either side (clock drift). Returns the matched
// step number or null. `lastStep` blocks replaying a code that was already used.
function verify(secretB32, code, now = Date.now(), lastStep = 0) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const key = base32Decode(secretB32);
  const cur = stepOf(now);
  for (const s of [cur - 1, cur, cur + 1]) {
    if (s <= lastStep) continue;
    const exp = hotp(key, s);
    if (crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(c))) return s;
  }
  return null;
}

const newSecret = () => base32Encode(crypto.randomBytes(20));
const otpauthUrl = (account, secret, issuer = 'Helpman') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;

// ---- the secret is stored ENCRYPTED (AES-256-GCM), never in clear text ----
const encKey = () => crypto.createHash('sha256').update('totp:' + (process.env.TOTP_ENC_KEY || process.env.JWT_SECRET || 'dev-only-secret-change-me')).digest();
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map(b => b.toString('base64')).join('.');
}
function decrypt(blob) {
  try {
    const [iv, tag, ct] = String(blob).split('.').map(s => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch (e) { return null; }
}

// ---- recovery codes: shown once, stored only as hashes, each usable once ----
const hashCode = (c) => crypto.createHash('sha256').update('rc:' + String(c).toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
function newRecoveryCodes(n = 8) {
  const codes = Array.from({ length: n }, () => {
    const h = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 chars
    return h.slice(0, 5) + '-' + h.slice(5);
  });
  return { codes, hashes: codes.map(hashCode) };
}
// Returns the remaining hashes if `code` matched one (and removes it), else null.
function consumeRecovery(hashesJson, code) {
  let list; try { list = JSON.parse(hashesJson || '[]'); } catch (e) { list = []; }
  const h = hashCode(code);
  const i = list.indexOf(h);
  if (i < 0) return null;
  list.splice(i, 1);
  return list;
}

module.exports = { base32Encode, base32Decode, hotp, codeAt, verify, newSecret, otpauthUrl, encrypt, decrypt, newRecoveryCodes, consumeRecovery, hashCode, STEP };
