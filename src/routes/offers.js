// Public magic-link endpoints: a contractor answers a job offer or confirms
// a scheduled day straight from the email — no login required. The signed
// token authenticates the action and expires (24 h).
const express = require('express');
const db = require('../db');
const { ah } = require('../middleware');
const offers = require('../services/offers');
const { esc } = require('../services/notify');

const router = express.Router();

// Public summary for the offer page (offer.html).
router.get('/offers/:token', ah(async (req, res) => {
  const { error, project } = await offers.loadByToken(req.params.token, 'offer');
  if (error) return res.status(403).json({ error: 'This link is invalid or expired.' });
  if (project.contractor_status !== 'offered') {
    return res.status(410).json({ error: 'This offer is no longer open.' });
  }
  if (project.offer_expires_at && project.offer_expires_at < new Date().toISOString()) {
    await offers.releaseExpiredOffers();
    return res.status(410).json({ error: 'This offer expired with no answer.' });
  }
  const job = await db.prepare('SELECT service_type, address, city, description FROM job_requests WHERE id = ?').get(project.job_request_id);
  const cont = await db.prepare('SELECT u.name FROM contractors c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(project.contractor_id);
  res.json({
    project_id: project.id,
    service_type: job.service_type,
    address: [job.address, job.city].filter(Boolean).join(', '),
    description: (job.description || '').slice(0, 300),
    contractor_name: cont ? cont.name : '',
    expires_at: project.offer_expires_at,
  });
}));

// Answer the offer from the email.
router.post('/offers/:token/respond', ah(async (req, res) => {
  const { error, project } = await offers.loadByToken(req.params.token, 'offer');
  if (error) return res.status(403).json({ error: 'This link is invalid or expired.' });
  if (project.contractor_status !== 'offered') {
    return res.status(410).json({ error: 'This offer is no longer open.' });
  }
  const accept = (req.body || {}).accept === true;
  if (!accept) {
    return res.json(await offers.declineOffer(project, { userId: null }));
  }
  // Same legal gate as the portal: accepting requires the Contractor Terms.
  if ((req.body || {}).terms_accepted !== true) {
    return res.status(400).json({ error: 'You must accept the Independent Contractor Terms to take this job.' });
  }
  const crow = await db.prepare('SELECT user_id FROM contractors WHERE id = ?').get(project.contractor_id);
  const out = await offers.acceptOffer(project, { userId: crow && crow.user_id, ip: req.ip || null });
  res.json({ accepted: true, project: out });
}));

// Public summary for the schedule-confirmation page (same offer.html).
router.get('/schedule-confirm/:token', ah(async (req, res) => {
  const { error, project } = await offers.loadByToken(req.params.token, 'schedule');
  if (error) return res.status(403).json({ error: 'This link is invalid or expired.' });
  if (project.schedule_status !== 'pending') {
    return res.status(410).json({ error: 'This schedule is no longer awaiting confirmation.' });
  }
  const job = await db.prepare('SELECT service_type FROM job_requests WHERE id = ?').get(project.job_request_id);
  res.json({
    project_id: project.id,
    service_type: job.service_type,
    day: project.scheduled_start ? String(project.scheduled_start).slice(0, 10) : '',
    arrival_window: project.arrival_window || '',
  });
}));

// Confirm / decline the scheduled day from the email.
router.post('/schedule-confirm/:token/respond', ah(async (req, res) => {
  const { error, project } = await offers.loadByToken(req.params.token, 'schedule');
  if (error) return res.status(403).json({ error: 'This link is invalid or expired.' });
  const accept = (req.body || {}).accept === true;
  const crow = await db.prepare('SELECT user_id FROM contractors WHERE id = ?').get(project.contractor_id);
  const out = await offers.respondToSchedule(project, { accept, contractorUserId: crow && crow.user_id });
  if (out.error) return res.status(410).json({ error: out.error });
  res.json(out);
}));

module.exports = router;
