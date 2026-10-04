// Auth: DUAL signup flows (customer / contractor), one login, JWT sessions.
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { ah, authRequired, isEmail, isPhone, isNonEmpty, failIfErrors, signToken } = require('../middleware');

const router = express.Router();

function hashPassword(pw) { return bcrypt.hashSync(pw, 10); }

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role };
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

  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim().toLowerCase());
  if (exists) return res.status(409).json({ error: 'An account with this email already exists.' });

  const info = db.prepare(
    'INSERT INTO users (name, email, phone, password_hash, role) VALUES (?,?,?,?,?)'
  ).run(name.trim(), email.trim().toLowerCase(), (phone || '').trim(), hashPassword(password), 'customer');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
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
  if (failIfErrors(res, errors)) return;

  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(b.email.trim().toLowerCase());
  if (exists) return res.status(409).json({ error: 'An account with this email already exists.' });

  const tx = db.transaction(() => {
    const u = db.prepare(
      'INSERT INTO users (name, email, phone, password_hash, role) VALUES (?,?,?,?,?)'
    ).run(b.name.trim(), b.email.trim().toLowerCase(), (b.phone || '').trim(), hashPassword(b.password), 'contractor');
    db.prepare(
      `INSERT INTO contractors (user_id, legal_name, city, service_base, service_radius_miles,
        years_experience, specialties, license_number, insurance_info)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      u.lastInsertRowid, b.legal_name.trim(), b.city.trim(), (b.service_base || b.city || '').trim(),
      Number(b.service_radius_miles) || 25, Number(b.years_experience) || 0,
      (b.specialties || '').trim(), (b.license_number || '').trim(), (b.insurance_info || '').trim()
    );
    return u.lastInsertRowid;
  });
  const userId = tx();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  res.status(201).json({
    token: signToken(user),
    user: publicUser(user),
    note: 'Contractor profile created with status "pending". An admin must verify license, insurance and background check before activation.',
  });
}));

// ---- LOGIN (both roles) ----
router.post('/login', ah(async (req, res) => {
  const { email, password } = req.body || {};
  if (!isEmail(email) || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  res.json({ token: signToken(user), user: publicUser(user) });
}));

router.get('/me', authRequired, ah(async (req, res) => {
  const out = { ...publicUser(req.user) };
  if (req.user.role === 'contractor') {
    out.contractor = db.prepare('SELECT * FROM contractors WHERE user_id = ?').get(req.user.id) || null;
  }
  res.json(out);
}));

module.exports = router;
