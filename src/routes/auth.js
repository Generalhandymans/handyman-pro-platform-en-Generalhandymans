// Auth: DUAL signup flows (customer / contractor), one login, JWT sessions,
// email verification + password recovery (tokens, expiring).
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { ah, authRequired, requireRole, isEmail, isPhone, isNonEmpty, failIfErrors, signToken, signChallenge, verifyChallenge } = require('../middleware');
const totp = require('../services/totp');
const { notify, shell } = require('../services/notify');
const { securityEvent } = require('../services/security');

const router = express.Router();

function hashPassword(pw) { return bcrypt.hashSync(pw, 10); }
function newToken() { return crypto.randomBytes(32).toString('hex'); }

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, email_verified: !!u.email_verified };
}

async function sendVerificationEmail(user, token) {
  const link = `${process.env.PUBLIC_URL || 'http://localhost:3000'}/api/auth/verify?token=${token}`;
  return await notify({
    to: user.email,
    subject: 'Verify your Helpman email',
    html: shell('Verify your email', `Hi ${user.name.split(' ')[0]}, please confirm this is your email address:`, [
      ['Account', user.email],
      ['Verify link', link],
    ]) + `<p style="text-align:center;margin:20px 0;"><a href="${link}" style="background:#111827;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">Verify my email</a></p>`,
  }).catch(() => {});
}

// ---- CUSTOMER signup ----
router.post('/signup/customer', ah(async (req, res) => {
  const { name, email, phone, password } = req.body || {};
  const errors = {};
  if (!isNonEmpty(name, 120)) errors.name = 'Full name is required.';
  if (!isEmail(email)) errors.email = 'A valid email is required.';
  if (phone && !isPhone(phone)) errors.phone = 'Phone looks invalid.';
  if (typeof password !== 'string' || password.length < 8) errors.password = 'Password must be at least 8 characters.';
  if (failIfErrors(res, errors)) return;

  const exists = await db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim().toLowerCase());
  if (exists) return res.status(409).json({ error: 'An account with this email already exists.' });

  const token = newToken();
  const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours
  const info = await db.prepare(
    'INSERT INTO users (name, email, phone, password_hash, role, verify_token, verify_expires) VALUES (?,?,?,?,?,?,?)'
  ).run(name.trim(), email.trim().toLowerCase(), (phone || '').trim(), hashPassword(password), 'customer', token, verifyExpires);
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  await sendVerificationEmail(user, token);
  // Branded welcome on top of the verification email.
  try {
    const { notify, welcomeCustomer } = require('../services/notify');
    await notify({ to: user.email, subject: 'Welcome to Helpman!', html: welcomeCustomer(user.name.split(' ')[0]) });
  } catch (_) { /* welcome must never break signup */ }
  res.status(201).json({ token: signToken(user), user: publicUser(user), verify_sent: true });
}));

// ---- CONTRACTOR signup: creates the user AND the contractor profile (status: pending) ----
router.post('/signup/contractor', ah(async (req, res) => {
  const b = req.body || {};
  const errors = {};
  if (!isNonEmpty(b.name, 120)) errors.name = 'Full name is required.';
  if (!isEmail(b.email)) errors.email = 'A valid email is required.';
  if (b.phone && !isPhone(b.phone)) errors.phone = 'Phone looks invalid.';
  if (typeof b.password !== 'string' || b.password.length < 8) errors.password = 'Password must be at least 8 characters.';
  if (!isNonEmpty(b.legal_name, 160)) errors.legal_name = 'Legal name is required.';
  if (!isNonEmpty(b.city, 120)) errors.city = 'City is required.';
  const kind = (b.contractor_kind || 'independent');
  if (!['independent', 'inhouse'].includes(kind)) errors.contractor_kind = 'Invalid contractor kind.';
  // has_license: when explicitly true, the license number becomes mandatory.
  // When absent (older clients), keep the previous lenient behavior.
  const hasLicense = b.has_license === undefined || b.has_license === null
    ? null
    : !(b.has_license === false || b.has_license === 0 || b.has_license === 'false');
  if (hasLicense === true && !isNonEmpty(b.license_number, 200)) errors.license_number = 'License number is required when you have a license.';
  if (failIfErrors(res, errors)) return;

  const exists = await db.prepare('SELECT id FROM users WHERE email = ?').get(b.email.trim().toLowerCase());
  if (exists) return res.status(409).json({ error: 'An account with this email already exists.' });

  const userId = await db.transaction(async (t) => {
    const u = await t.prepare(
      'INSERT INTO users (name, email, phone, password_hash, role) VALUES (?,?,?,?,?)'
    ).run(b.name.trim(), b.email.trim().toLowerCase(), (b.phone || '').trim(), hashPassword(b.password), 'contractor');
    await t.prepare(
      `INSERT INTO contractors (user_id, legal_name, city, service_base, service_radius_miles,
        years_experience, specialties, license_number, insurance_info, has_license, contractor_kind)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      u.lastInsertRowid, b.legal_name.trim(), b.city.trim(), (b.service_base || b.city || '').trim(),
      Number(b.service_radius_miles) || 25, Number(b.years_experience) || 0,
      (b.specialties || '').trim(), (b.license_number || '').trim(), (b.insurance_info || '').trim(),
      hasLicense === false ? 0 : 1, kind
    );
    return u.lastInsertRowid;
  });
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const vtoken = newToken();
  const vexp = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours
  await db.prepare('UPDATE users SET verify_token = ?, verify_expires = ? WHERE id = ?').run(vtoken, vexp, userId);
  await sendVerificationEmail(user, vtoken);
  // Branded welcome + the photo reminder: no contractor is offered work
  // until their profile photo is on file.
  try {
    const { notify, welcomeContractor, photoReminder } = require('../services/notify');
    const first = user.name.split(' ')[0];
    await notify({ to: user.email, subject: 'Welcome to Helpman — contractor', html: welcomeContractor(first) });
    await notify({ to: user.email, subject: 'Action needed: upload your profile photo', html: photoReminder(first) });
  } catch (_) { /* welcome must never break signup */ }
  res.status(201).json({
    token: signToken(user),
    user: publicUser(user),
    verify_sent: true,
    has_license: hasLicense,
    contractor_kind: kind,
    note: hasLicense === false
      ? 'Your application has gone to review. We will notify you when it is active.'
      : 'Contractor profile created with status "pending". An admin must verify license, insurance and background check before activation.',
  });
}));

// ---- LOGIN (both roles) ----
router.post('/login', ah(async (req, res) => {
  const { email, password } = req.body || {};
  if (!isEmail(email) || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    await securityEvent(req, 'login_failed', 'warning', `email=${email.trim().toLowerCase().slice(0,80)}`, user ? user.id : null);
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  if (user.role === 'admin' && user.staff_role === 'disabled') {
    return res.status(403).json({ error: 'This account is disabled. Ask an owner.' });
  }
  // Two-step verification: the password alone does NOT open a session.
  if (user.totp_enabled) {
    return res.json({ two_factor_required: true, challenge: signChallenge(user) });
  }
  res.json({ token: signToken(user), user: publicUser(user) });
}));

// ---- Two-step verification ----
// Step 2 of login: a 6-digit app code, or a one-time recovery code.
router.post('/2fa/verify', ah(async (req, res) => {
  const { challenge, code } = req.body || {};
  const bad = () => res.status(401).json({ error: 'That code is not valid.' });
  const payload = verifyChallenge(challenge);
  if (!payload) return res.status(401).json({ error: 'Your sign-in expired. Please sign in again.' });
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
  if (!user || !user.totp_enabled || (payload.tv || 0) !== (user.token_version || 0) ||
      (user.role === 'admin' && user.staff_role === 'disabled')) {
    return res.status(401).json({ error: 'Please sign in again.' });
  }
  const secret = totp.decrypt(user.totp_secret);
  if (!secret) return res.status(500).json({ error: 'Two-step data could not be read. Ask an owner to reset it.' });

  const step = totp.verify(secret, code, Date.now(), Number(user.totp_last_step) || 0);
  if (step !== null) {
    // Atomic anti-replay: a code can open a session only once.
    const upd = await db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?').run(step, user.id, step);
    if (upd.changes !== 1) return bad();
    return res.json({ token: signToken(user), user: publicUser(user) });
  }
  const left = totp.consumeRecovery(user.totp_recovery, code);
  if (left) {
    const upd = await db.prepare('UPDATE users SET totp_recovery = ? WHERE id = ? AND totp_recovery = ?').run(JSON.stringify(left), user.id, user.totp_recovery);
    if (upd.changes !== 1) return bad();
    return res.json({ token: signToken(user), user: publicUser(user), recovery_codes_left: left.length });
  }
  return bad();
}));

// Start setup: returns the key to type (or scan) into the authenticator app.
router.post('/2fa/setup', authRequired, requireRole('admin'), ah(async (req, res) => {
  const row = await db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(req.user.id);
  if (row.totp_enabled) return res.status(409).json({ error: 'Two-step verification is already on.' });
  const secret = totp.newSecret();
  await db.prepare('UPDATE users SET totp_secret = ?, totp_last_step = 0 WHERE id = ?').run(totp.encrypt(secret), req.user.id);
  res.json({ secret, otpauth_url: totp.otpauthUrl(req.user.email, secret) });
}));

// Confirm with a code from the app. Returns the recovery codes ONCE.
router.post('/2fa/enable', authRequired, requireRole('admin'), ah(async (req, res) => {
  const row = await db.prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?').get(req.user.id);
  if (row.totp_enabled) return res.status(409).json({ error: 'Two-step verification is already on.' });
  const secret = row.totp_secret && totp.decrypt(row.totp_secret);
  if (!secret) return res.status(409).json({ error: 'Start the setup first.' });
  const step = totp.verify(secret, (req.body || {}).code, Date.now(), 0);
  if (step === null) return res.status(422).json({ error: 'That code is not valid. Check the time on your phone and try again.' });
  const rc = totp.newRecoveryCodes(8);
  await db.prepare('UPDATE users SET totp_enabled = 1, totp_last_step = ?, totp_recovery = ? WHERE id = ?')
    .run(step, JSON.stringify(rc.hashes), req.user.id);
  res.json({ enabled: true, recovery_codes: rc.codes });
}));

// Turn it off: needs the password AND a current code (or a recovery code).
router.post('/2fa/disable', authRequired, requireRole('admin'), ah(async (req, res) => {
  const { password, code } = req.body || {};
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user.totp_enabled) return res.status(409).json({ error: 'Two-step verification is not on.' });
  if (typeof password !== 'string' || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(403).json({ error: 'Password is incorrect.' });
  }
  const secret = totp.decrypt(user.totp_secret);
  const okCode = (secret && totp.verify(secret, code, Date.now(), Number(user.totp_last_step) || 0) !== null) ||
    totp.consumeRecovery(user.totp_recovery, code) !== null;
  if (!okCode) return res.status(422).json({ error: 'That code is not valid.' });
  await db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_last_step = 0, totp_recovery = NULL WHERE id = ?').run(user.id);
  res.json({ enabled: false });
}));

router.get('/me', authRequired, ah(async (req, res) => {
  const out = { ...publicUser(req.user) };
  if (req.user.role === 'admin') {
    const perms = require('../services/permissions');
    out.staff_role = perms.effectiveRole(req.user);
    out.permissions = perms.permissionsOf(req.user);
    out.totp_enabled = !!req.user.totp_enabled;
    out.mfa_required = perms.mfaRequired(req.user);
  }
  if (req.user.role === 'contractor') {
    out.contractor = await db.prepare('SELECT * FROM contractors WHERE user_id = ?').get(req.user.id) || null;
  }
  res.json(out);
}));

// ---- Email verification ----
router.get('/verify', ah(async (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.status(400).json({ error: 'Verification token is required.' });
  const user = await db.prepare('SELECT * FROM users WHERE verify_token = ?').get(token);
  if (!user) return res.status(400).json({ error: 'Invalid or expired verification token.' });
  if (user.verify_expires && new Date(user.verify_expires).getTime() < Date.now()) {
    return res.status(400).json({ error: 'Verification link expired. Request a new one.' });
  }
  await db.prepare('UPDATE users SET email_verified = 1, verify_token = NULL, verify_expires = NULL WHERE id = ?').run(user.id);
  res.json({ verified: true, email: user.email });
}));

// Resend the verification email (logged-in user).
router.post('/verify/resend', authRequired, ah(async (req, res) => {
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (user.email_verified) return res.json({ verified: true, already: true });
  const token = newToken();
  const vexp = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours
  await db.prepare('UPDATE users SET verify_token = ?, verify_expires = ? WHERE id = ?').run(token, vexp, user.id);
  await sendVerificationEmail(user, token);
  res.json({ verify_sent: true });
}));

// ---- Password recovery: request a reset link ----
router.post('/forgot', ah(async (req, res) => {
  const { email } = req.body || {};
  // Always respond the same way: never reveal whether the email exists.
  const done = () => res.json({ sent: true, note: 'If that email is registered, a reset link is on its way.' });
  if (!isEmail(email)) return done();
  const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
  if (!user) return done();
  const token = newToken();
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
  await db.prepare('UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?').run(token, expires, user.id);
  const link = `${process.env.PUBLIC_URL || 'http://localhost:3000'}/auth.html?reset=${token}`;
  await notify({
    to: user.email,
    subject: 'Reset your Helpman password',
    html: shell('Reset your password', `Hi ${user.name.split(' ')[0]}, use the link below within 1 hour:`, [
      ['Reset link', link],
    ]) + `<p style="text-align:center;margin:20px 0;"><a href="${link}" style="background:#111827;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">Reset password</a></p>`,
  }).catch(() => {});
  return done();
}));

// ---- Password recovery: set the new password ----
router.post('/reset', ah(async (req, res) => {
  const { token, password } = req.body || {};
  const errors = {};
  if (typeof token !== 'string' || !token) errors.token = 'Reset token is required.';
  if (typeof password !== 'string' || password.length < 8) errors.password = 'Password must be at least 8 characters.';
  if (failIfErrors(res, errors)) return;
  const user = await db.prepare('SELECT * FROM users WHERE reset_token = ?').get(token);
  if (!user || !user.reset_expires || new Date(user.reset_expires).getTime() < Date.now()) {
    return res.status(400).json({ error: 'Invalid or expired reset token.' });
  }
  await db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires = NULL, token_version = COALESCE(token_version, 0) + 1 WHERE id = ?')
    .run(hashPassword(password), user.id);
  res.json({ reset: true });
}));

module.exports = router;
