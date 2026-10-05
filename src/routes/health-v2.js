'use strict';

const express = require('express');
const db = require('../db/postgres');

const router = express.Router();

router.get('/live', (req, res) => {
  res.json({ ok: true, service: 'general-handyman-solutions' });
});

router.get('/ready', async (req, res) => {
  try {
    const pg = await db.health();
    res.json({
      ok: true,
      postgres: pg.ok,
      stripe_configured: !!process.env.STRIPE_SECRET_KEY,
      storage_configured: !!process.env.S3_BUCKET,
      email_configured: process.env.EMAIL_PROVIDER !== 'console',
      ai_enabled: process.env.AI_ENABLED === 'true',
    });
  } catch (err) {
    res.status(503).json({ ok: false, postgres: false });
  }
});

module.exports = router;
