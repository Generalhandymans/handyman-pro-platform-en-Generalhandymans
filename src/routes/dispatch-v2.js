'use strict';

const express = require('express');
const db = require('../db/postgres');
const { rankContractors } = require('../services/matching');

const router = express.Router();

function milesBetween(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some(v => v == null)) return null;
  const R = 3958.8;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(Number(lat2) - Number(lat1));
  const dLon = toRad(Number(lon2) - Number(lon1));
  const a =
    Math.sin(dLat/2) ** 2 +
    Math.cos(toRad(Number(lat1))) *
    Math.cos(toRad(Number(lat2))) *
    Math.sin(dLon/2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

router.get('/projects/:id/recommendations', async (req, res, next) => {
  try {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only.' });
    }

    const project = await db.one(
      `SELECT p.*, j.service_type, j.latitude, j.longitude
       FROM projects p
       JOIN job_requests j ON j.id = p.job_request_id
       WHERE p.id = $1`,
      [req.params.id]
    );
    if (!project) return res.status(404).json({ error: 'Project not found.' });

    const contractors = await db.many(
      `SELECT c.*, u.name
       FROM contractors c JOIN users u ON u.id = c.user_id
       WHERE c.status = 'active'`
    );

    const enriched = contractors.map(c => ({
      ...c,
      distance_miles: milesBetween(
        project.latitude, project.longitude,
        c.base_lat, c.base_lng
      ),
    }));

    const ranked = rankContractors(project, enriched).slice(0, 10);

    res.json(ranked.map(({ contractor, match }) => ({
      contractor_id: contractor.id,
      contractor_name: contractor.legal_name || contractor.name,
      score: match.score,
      distance_miles: contractor.distance_miles,
      parts: match.parts,
      explanation: match.explanation,
    })));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
