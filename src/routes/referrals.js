// Referrals: customers earn discount codes for bringing new customers.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { ah, authRequired, requireRole, isEmail, failIfErrors } = require('../middleware');

const router = express.Router();

function makeCode() {
  return 'HP-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

router.post('/', authRequired, requireRole('customer'), ah(async (req, res) => {
  const info = db.prepare(
    'INSERT INTO referrals (code, referrer_user_id, discount_pct) VALUES (?,?,?)'
  ).run(makeCode(), req.user.id, 10);
  res.status(201).json(db.prepare('SELECT * FROM referrals WHERE id = ?').get(info.lastInsertRowid));
}));

router.get('/mine', authRequired, requireRole('customer'), ah(async (req, res) => {
  res.json(db.prepare('SELECT * FROM referrals WHERE referrer_user_id = ? ORDER BY id DESC').all(req.user.id));
}));

// Redeem a code for a new customer email (public; validated at quote time by admin).
router.post('/redeem', ah(async (req, res) => {
  const { code, email } = req.body || {};
  const errors = {};
  if (!code || typeof code !== 'string') errors.code = 'Code required.';
  if (!isEmail(email)) errors.email = 'Valid email required.';
  if (failIfErrors(res, errors)) return;
  const r = db.prepare('SELECT * FROM referrals WHERE code = ?').get(code.trim().toUpperCase());
  if (!r) return res.status(404).json({ error: 'Unknown referral code.' });
  if (r.status === 'redeemed') return res.status(409).json({ error: 'Code already redeemed.' });
  db.prepare(`UPDATE referrals SET status = 'redeemed', referred_email = ?, redeemed_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(email.trim().toLowerCase(), r.id);
  res.json({ ok: true, discount_pct: r.discount_pct });
}));

module.exports = router;
