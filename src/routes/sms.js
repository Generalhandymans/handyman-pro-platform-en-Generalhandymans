// SMS endpoints: my consent, Twilio's inbound webhook (STOP / START), the log, run reminders now.
'use strict';
const express = require('express');
const db = require('../db');
const { ah, authRequired } = require('../middleware');
const { requireStaff } = require('../services/permissions');
const { auditLog } = require('../services/audit');
const sms = require('../services/sms');

const router = express.Router();

// ---- Twilio inbound (public; authenticated by Twilio's signature) ----
// Configure in Twilio: "A message comes in" -> POST https://YOUR-DOMAIN/api/sms/inbound
router.post('/inbound', ah(async (req, res) => {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return res.status(503).type('text/plain').send('SMS is not configured.');
  const url = `${process.env.PUBLIC_URL || ''}/api/sms/inbound`;
  if (!sms.verifyTwilio(url, req.body || {}, req.headers['x-twilio-signature'], token)) {
    return res.status(403).type('text/plain').send('Invalid signature.');
  }
  const kw = sms.keywordOf(req.body.Body);
  const from = sms.normalizePhone(req.body.From);
  if (from) {
    if (sms.STOP_WORDS.has(kw)) await sms.setConsent(from, false, 'inbound:' + kw);
    else if (sms.START_WORDS.has(kw)) await sms.setConsent(from, true, 'inbound:' + kw);
  }
  res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>'); // Twilio sends the standard STOP/START replies itself
}));

// ---- My consent (the phone on my account) ----
router.get('/status', authRequired, ah(async (req, res) => {
  const row = await db.prepare('SELECT phone FROM users WHERE id = ?').get(req.user.id);
  const phone = sms.normalizePhone(row && row.phone);
  res.json({ phone, opted_in: phone ? await sms.hasConsent(phone) : false, provider: sms.provider() });
}));
router.post('/opt-in', authRequired, ah(async (req, res) => {
  const row = await db.prepare('SELECT phone FROM users WHERE id = ?').get(req.user.id);
  const phone = sms.normalizePhone(row && row.phone);
  if (!phone) return res.status(422).json({ error: 'Add a valid mobile number to your account first.' });
  const optIn = (req.body || {}).opt_in === true;
  await sms.setConsent(phone, optIn, 'portal');
  res.json({ phone, opted_in: optIn });
}));

// ---- Staff ----
router.get('/log', authRequired, requireStaff('read'), ah(async (req, res) => {
  res.json(await db.prepare('SELECT * FROM sms_log ORDER BY id DESC LIMIT 100').all());
}));
router.post('/run-reminders', authRequired, requireStaff('dispatch'), ah(async (req, res) => {
  const out = await sms.runReminders({ force: (req.body || {}).force === true });
  await auditLog(req.user.id, 'sms.reminders_run', 'projects', null, JSON.stringify(out));
  res.json(out);
}));

module.exports = router;
