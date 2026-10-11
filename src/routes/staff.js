// Team management (owner only): invite staff, change their role, deactivate.
'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { ah, authRequired, isEmail, isNonEmpty, failIfErrors } = require('../middleware');
const { requireStaff, ASSIGNABLE, effectiveRole } = require('../services/permissions');
const { auditLog } = require('../services/audit');
const { notify, shell } = require('../services/notify');

const router = express.Router();
router.use(authRequired, requireStaff('staff'));

const ownersLeft = async (excludeId) => Number((await db.prepare(
  `SELECT COUNT(*) c FROM users WHERE role = 'admin' AND (staff_role IS NULL OR staff_role = 'owner') AND id <> ?`
).get(excludeId || 0)).c);

router.get('/', ah(async (req, res) => {
  const rows = await db.prepare(
    `SELECT id, name, email, staff_role, totp_enabled, created_at FROM users WHERE role = 'admin' ORDER BY id`
  ).all();
  res.json(rows.map(r => ({ ...r, staff_role: r.staff_role || 'owner', totp_enabled: !!r.totp_enabled })));
}));

// Invite: creates the account with a random password and emails a set-password link.
router.post('/', ah(async (req, res) => {
  const b = req.body || {};
  const errors = {};
  if (!isNonEmpty(b.name, 120)) errors.name = 'Name is required.';
  if (!isEmail(b.email)) errors.email = 'A valid email is required.';
  if (!ASSIGNABLE.includes(b.staff_role)) errors.staff_role = 'Choose one of: ' + ASSIGNABLE.join(', ') + '.';
  if (failIfErrors(res, errors)) return;
  const email = b.email.trim().toLowerCase();
  if (await db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'That email already has an account.' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const hash = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10); // unknown until they set their own
  const info = await db.prepare(
    `INSERT INTO users (name, email, phone, password_hash, role, staff_role, email_verified, reset_token, reset_expires)
     VALUES (?,?,?,?,'admin',?,1,?,?)`
  ).run(b.name.trim(), email, '', hash, b.staff_role, token, expires);
  const link = `${process.env.PUBLIC_URL || 'http://localhost:3000'}/auth.html?reset=${token}`;
  await notify({
    to: email,
    subject: 'You were added to the General Handyman Solutions team',
    html: shell('Welcome to the team', `Hi ${b.name.trim().split(' ')[0]}, you were added as ${b.staff_role}. Set your password within 24 hours:`, [['Set password', link]]),
  }).catch(() => {});
  await auditLog(req.user.id, 'staff.invited', 'users', info.lastInsertRowid, `${email} as ${b.staff_role}`);
  res.status(201).json({ id: info.lastInsertRowid, email, staff_role: b.staff_role });
}));

router.patch('/:id', ah(async (req, res) => {
  const role = (req.body || {}).staff_role;
  if (!ASSIGNABLE.includes(role)) return res.status(422).json({ error: 'Validation failed', fields: { staff_role: 'Choose one of: ' + ASSIGNABLE.join(', ') + '.' } });
  const u = await db.prepare(`SELECT id, role, staff_role FROM users WHERE id = ? AND role = 'admin'`).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Team member not found.' });
  const wasOwner = !u.staff_role || u.staff_role === 'owner';
  if (wasOwner && role !== 'owner' && (await ownersLeft(u.id)) < 1) {
    return res.status(409).json({ error: 'There must always be at least one owner.' });
  }
  await db.prepare('UPDATE users SET staff_role = ? WHERE id = ?').run(role, u.id);
  await auditLog(req.user.id, 'staff.role_changed', 'users', u.id, `${effectiveRole(u)} → ${role}`);
  res.json({ id: u.id, staff_role: role });
}));

// Lost phone: an owner clears a colleague's two-step setup (they sign in again and re-enrol).
router.post('/:id/reset-2fa', ah(async (req, res) => {
  const u = await db.prepare(`SELECT id FROM users WHERE id = ? AND role = 'admin'`).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Team member not found.' });
  if (u.id === req.user.id) return res.status(409).json({ error: 'Use "Turn off" in your own Security tab.' });
  await db.prepare(`UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_last_step = 0, totp_recovery = NULL,
                    token_version = COALESCE(token_version,0) + 1 WHERE id = ?`).run(u.id);
  await auditLog(req.user.id, 'staff.2fa_reset', 'users', u.id, 'Two-step verification reset');
  res.json({ id: u.id, totp_enabled: false });
}));

router.post('/:id/deactivate', ah(async (req, res) => {
  const u = await db.prepare(`SELECT id, role, staff_role FROM users WHERE id = ? AND role = 'admin'`).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Team member not found.' });
  if (u.id === req.user.id) return res.status(409).json({ error: 'You cannot deactivate yourself.' });
  const wasOwner = !u.staff_role || u.staff_role === 'owner';
  if (wasOwner && (await ownersLeft(u.id)) < 1) return res.status(409).json({ error: 'There must always be at least one owner.' });
  // token_version + 1 kills every session they have open right now.
  await db.prepare(`UPDATE users SET staff_role = 'disabled', token_version = COALESCE(token_version,0) + 1 WHERE id = ?`).run(u.id);
  await auditLog(req.user.id, 'staff.deactivated', 'users', u.id, 'Account deactivated');
  res.json({ id: u.id, staff_role: 'disabled' });
}));

module.exports = router;
