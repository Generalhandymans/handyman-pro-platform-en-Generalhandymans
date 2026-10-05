'use strict';

const express = require('express');
const db = require('../db/postgres');
const storage = require('../services/storage');

const router = express.Router();

/**
 * Expects existing auth middleware to place req.user.
 * Never exposes the storage key directly to unauthorized users.
 */
router.get('/:id/url', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });

    const media = await db.one(
      `SELECT m.*, j.customer_id, p.contractor_id, c.user_id AS contractor_user_id
       FROM media_objects m
       LEFT JOIN job_requests j ON j.id = m.job_request_id
       LEFT JOIN projects p ON p.id = m.project_id
       LEFT JOIN contractors c ON c.id = p.contractor_id
       WHERE m.id = $1`,
      [req.params.id]
    );

    if (!media) return res.status(404).json({ error: 'Media not found.' });

    const allowed =
      req.user.role === 'admin' ||
      (req.user.role === 'customer' && media.customer_id === req.user.id) ||
      (req.user.role === 'contractor' && media.contractor_user_id === req.user.id);

    if (!allowed) return res.status(403).json({ error: 'Not allowed.' });

    const url = await storage.signedReadUrl(media.storage_key, 180);
    res.json({ url, expires_in: 180 });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
