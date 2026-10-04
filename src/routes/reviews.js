// Reviews: customer rates the contractor after a completed project.
const express = require('express');
const db = require('../db');
const { ah, authRequired, isInt, isNonEmpty, failIfErrors } = require('../middleware');

const router = express.Router();

router.post('/', authRequired, ah(async (req, res) => {
  const b = req.body || {};
  const errors = {};
  if (!isInt(b.project_id, 1, 1e9)) errors.project_id = 'Project required.';
  if (!isInt(b.rating, 1, 5)) errors.rating = 'Rating must be 1-5.';
  if (b.comment && !isNonEmpty(b.comment, 2000)) errors.comment = 'Comment too long.';
  if (failIfErrors(res, errors)) return;

  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(b.project_id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  const job = db.prepare('SELECT customer_id FROM job_requests WHERE id = ?').get(p.job_request_id);
  const isOwner = job.customer_id === req.user.id;
  if (req.user.role !== 'admin' && !isOwner) return res.status(403).json({ error: 'Not allowed.' });
  if (p.stage !== 'completed') return res.status(400).json({ error: 'Reviews are only for completed projects.' });
  if (!p.contractor_id) return res.status(400).json({ error: 'No contractor on this project.' });
  const dup = db.prepare('SELECT id FROM reviews WHERE project_id = ?').get(p.id);
  if (dup) return res.status(409).json({ error: 'This project was already reviewed.' });

  const tx = db.transaction(() => {
    const info = db.prepare(
      'INSERT INTO reviews (project_id, contractor_id, customer_id, rating, comment) VALUES (?,?,?,?,?)'
    ).run(p.id, p.contractor_id, job.customer_id, b.rating, (b.comment || '').trim());
    const agg = db.prepare('SELECT AVG(rating) a, COUNT(*) c FROM reviews WHERE contractor_id = ?').get(p.contractor_id);
    db.prepare('UPDATE contractors SET rating_avg = ? WHERE id = ?').run(Math.round(agg.a * 10) / 10, p.contractor_id);
    return info.lastInsertRowid;
  });
  const id = tx();
  res.status(201).json(db.prepare('SELECT * FROM reviews WHERE id = ?').get(id));
}));

router.get('/', ah(async (req, res) => {
  const { contractor_id } = req.query;
  const rows = contractor_id
    ? db.prepare('SELECT * FROM reviews WHERE contractor_id = ? ORDER BY id DESC').all(contractor_id)
    : db.prepare('SELECT * FROM reviews ORDER BY id DESC LIMIT 100').all();
  res.json(rows);
}));

module.exports = router;
