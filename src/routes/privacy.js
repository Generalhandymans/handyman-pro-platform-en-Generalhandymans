// Privacy: export my data, delete (anonymize) my account.
// The privacy policy promises both. Financial and project records are RETAINED
// (anonymized) because the business needs them for accounting, warranty and
// dispute handling; everything that identifies the person is removed.
'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { ah, authRequired } = require('../middleware');
const unsub = require('../services/unsubscribe');
const storage = require('../services/storage');

const router = express.Router();
router.use(authRequired);

const ACTIVE = `('assigned','scheduled','in_progress','review')`;

// ---- Export everything we hold about the logged-in person (JSON) ----
router.get('/export', ah(async (req, res) => {
  const u = req.user;
  const profile = await db.prepare('SELECT id, name, email, phone, role, email_verified, created_at FROM users WHERE id = ?').get(u.id);
  const out = { exported_at: new Date().toISOString(), profile };

  if (u.role === 'customer') {
    out.requests = await db.prepare('SELECT id, name, phone, email, address, city, state, zip, service_type, urgency, description, status, created_at FROM job_requests WHERE customer_id = ?').all(u.id);
    const ids = out.requests.map(r => r.id);
    const inList = ids.length ? ids.map(() => '?').join(',') : 'NULL';
    out.quotes = await db.prepare(`SELECT id, job_request_id, customer_price_cents, deposit_cents, deposit_pct, status, sent_at, responded_at FROM quotes WHERE job_request_id IN (${inList})`).all(...ids);
    // customer view: never include the contractor cost (platform margin)
    out.projects = await db.prepare(
      `SELECT p.id, p.job_request_id, p.customer_price_cents, p.stage, p.scheduled_start, p.scheduled_end, p.created_at
       FROM projects p WHERE p.job_request_id IN (${inList})`).all(...ids);
    const pids = out.projects.map(p => p.id);
    const pIn = pids.length ? pids.map(() => '?').join(',') : 'NULL';
    out.payments = await db.prepare(`SELECT id, project_id, kind, amount_cents, status, created_at FROM payments WHERE project_id IN (${pIn})`).all(...pids);
    out.messages = await db.prepare(
      `SELECT m.id, m.body, m.sender_role, m.created_at FROM messages m
       JOIN message_threads t ON t.id = m.thread_id
       WHERE t.kind = 'client_support' AND t.project_id IN (${pIn})`).all(...pids);
    out.reviews = await db.prepare('SELECT id, project_id, rating, comment, created_at FROM reviews WHERE customer_id = ?').all(u.id);
  } else if (u.role === 'contractor') {
    const c = await db.prepare('SELECT * FROM contractors WHERE user_id = ?').get(u.id);
    out.contractor_profile = c || null;
    const cid = c ? c.id : -1;
    // contractor view: never include what the customer paid
    out.projects = await db.prepare('SELECT id, contractor_cost_cents, stage, scheduled_start, scheduled_end, created_at FROM projects WHERE contractor_id = ?').all(cid);
    out.reviews_received = await db.prepare('SELECT id, project_id, rating, comment, created_at FROM reviews WHERE contractor_id = ?').all(cid);
    out.messages = await db.prepare(
      `SELECT m.id, m.body, m.sender_role, m.created_at FROM messages m
       JOIN message_threads t ON t.id = m.thread_id
       JOIN projects p ON p.id = t.project_id
       WHERE t.kind = 'support_contractor' AND p.contractor_id = ?`).all(cid);
  }
  out.terms_acceptances = await db.prepare('SELECT kind, reference_id, terms_version, accepted_at FROM terms_acceptances WHERE user_id = ?').all(u.id);
  res.setHeader('Content-Disposition', 'attachment; filename="my-data.json"');
  res.json(out);
}));

// ---- Delete (anonymize) my account. Requires the password as confirmation. ----
router.post('/delete', ah(async (req, res) => {
  const u = req.user;
  if (u.role === 'admin') return res.status(403).json({ error: 'Administrator accounts cannot be deleted here.' });
  const password = (req.body || {}).password;
  const row = await db.prepare('SELECT password_hash, email FROM users WHERE id = ?').get(u.id);
  if (typeof password !== 'string' || !row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(403).json({ error: 'Password is incorrect.' });
  }

  // Cannot disappear mid-job.
  let active;
  if (u.role === 'customer') {
    active = await db.prepare(
      `SELECT COUNT(*) c FROM projects p JOIN job_requests j ON j.id = p.job_request_id
       WHERE j.customer_id = ? AND p.stage IN ${ACTIVE}`).get(u.id);
  } else {
    const c = await db.prepare('SELECT id FROM contractors WHERE user_id = ?').get(u.id);
    active = c ? await db.prepare(`SELECT COUNT(*) c FROM projects WHERE contractor_id = ? AND stage IN ${ACTIVE}`).get(c.id) : { c: 0 };
  }
  if (Number(active.c) > 0) {
    return res.status(409).json({ error: 'You have a project in progress. Please contact support to close it first.' });
  }

  // Photos of the customer's requests (interiors of a home) are deleted for real.
  const doomed = u.role === 'customer'
    ? await db.prepare(
        `SELECT ph.id, ph.filename, ph.storage_key, ph.storage_provider FROM photos ph
         JOIN job_requests j ON j.id = ph.job_request_id WHERE j.customer_id = ?`).all(u.id)
    : [];

  const oldEmail = row.email;
  await db.transaction(async (t) => {
    const randomHash = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);
    await t.prepare(
      `UPDATE users SET name = 'Deleted user', email = ?, phone = '', password_hash = ?,
         verify_token = NULL, reset_token = NULL, reset_expires = NULL, email_verified = 0,
         token_version = COALESCE(token_version, 0) + 1 WHERE id = ?`
    ).run(`deleted-${u.id}@deleted.invalid`, randomHash, u.id);
    if (u.role === 'customer') {
      await t.prepare(
        `UPDATE job_requests SET name = 'Deleted user', phone = '', email = NULL, address = '[removed]',
           city = '', zip = '', claim_token = NULL, lat = NULL, lng = NULL WHERE customer_id = ?`
      ).run(u.id);
      for (const p of doomed) await t.prepare('DELETE FROM photos WHERE id = ?').run(p.id);
    } else {
      await t.prepare(
        `UPDATE contractors SET legal_name = 'Deleted contractor', city = NULL, service_base = NULL,
           license_number = NULL, insurance_info = NULL, status = 'suspended', lat = NULL, lng = NULL
         WHERE user_id = ?`
      ).run(u.id);
    }
    await t.prepare('UPDATE referrals SET referred_email = NULL WHERE referred_user_id = ?').run(u.id);
  });

  // Files are removed after the database commit (best effort).
  for (const p of doomed) {
    try {
      if (p.storage_provider === 's3' && p.storage_key && storage.isConfigured()) await storage.deleteObject(p.storage_key);
      else require('fs').unlinkSync(require('path').join(__dirname, '..', '..', 'uploads', p.filename));
    } catch (e) { /* already gone */ }
  }
  await unsub.suppress(oldEmail, 'account deleted'); // never market to a deleted account
  res.json({ deleted: true });
}));

module.exports = router;
