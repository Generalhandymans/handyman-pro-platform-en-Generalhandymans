// SendGrid Event Webhook receiver: bounces, spam complaints and unsubscribes
// go straight onto the suppression list, so we stop mailing those addresses.
// Configure in SendGrid: Settings > Mail Settings > Event Webhook, URL:
//   https://YOUR-DOMAIN/api/email/events?key=<SENDGRID_WEBHOOK_KEY>
// and tick: Bounced, Dropped, Spam Reports, Unsubscribes, Group Unsubscribes.
// Auth is a shared secret in the URL (constant-time compare). NOT exercised
// against live SendGrid in this repo's tests.
'use strict';
const express = require('express');
const crypto = require('crypto');
const { ah } = require('../middleware');
const unsub = require('../services/unsubscribe');

const router = express.Router();
const SUPPRESS_ON = new Set(['bounce', 'dropped', 'spamreport', 'unsubscribe', 'group_unsubscribe']);

router.post('/events', ah(async (req, res) => {
  const secret = process.env.SENDGRID_WEBHOOK_KEY;
  if (!secret) return res.status(503).json({ error: 'Email events are not configured.' });
  const given = String(req.query.key || '');
  if (given.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    return res.status(401).json({ error: 'Invalid key.' });
  }
  const events = Array.isArray(req.body) ? req.body : [];
  let suppressed = 0;
  for (const ev of events) {
    if (ev && typeof ev.email === 'string' && SUPPRESS_ON.has(ev.event)) {
      await unsub.suppress(ev.email, `sendgrid:${ev.event}`);
      suppressed++;
    }
  }
  res.json({ received: events.length, suppressed });
}));

module.exports = router;
