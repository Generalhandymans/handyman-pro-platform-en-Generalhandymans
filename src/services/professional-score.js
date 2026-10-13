'use strict';

const db = require('../db');

const clamp = (n, min=0, max=100) => Math.max(min, Math.min(max, n));

async function contractorMetrics(contractorId) {
  const c = await db.prepare('SELECT * FROM contractors WHERE id = ?').get(contractorId);
  if (!c) return null;

  const projects = await db.prepare(
    `SELECT id, stage, contractor_status, created_at, updated_at
     FROM projects WHERE contractor_id = ?`
  ).all(contractorId);

  let reviews = [];
  if (projects.length) {
    reviews = await db.prepare('SELECT rating FROM reviews WHERE contractor_id = ?').all(contractorId);
  }

  // Offer events are the canonical source for response behavior when available.
  const offerRows = await db.prepare(
    'SELECT event_type, COUNT(*) AS c FROM contractor_offer_events WHERE contractor_id = ? GROUP BY event_type'
  ).all(contractorId);
  const offerMap = Object.fromEntries(offerRows.map(x => [x.event_type, Number(x.c || 0)]));

  const qualityRows = await db.prepare(
    'SELECT COALESCE(SUM(points),0) AS points FROM contractor_quality_events WHERE contractor_id = ?'
  ).get(contractorId);

  const docs = await db.prepare(
    'SELECT doc_type, status, expires_on FROM contractor_documents WHERE contractor_id = ?'
  ).all(contractorId);

  const now = Date.now();
  const verifiedDocs = docs.filter(d =>
    d.status === 'verified' && (!d.expires_on || new Date(d.expires_on).getTime() >= now)
  );

  const offered = offerMap.offered || Math.max(projects.length, 0);
  const accepted = offerMap.accepted || projects.filter(p => p.contractor_status === 'accepted').length;
  const completed = projects.filter(p => p.stage === 'completed').length;
  const cancelled = projects.filter(p => p.stage === 'cancelled').length;
  const avgRating = reviews.length
    ? reviews.reduce((a,b)=>a+Number(b.rating||0),0)/reviews.length
    : Number(c.rating_avg || 0);

  return {
    contractor: c,
    projects_total: projects.length,
    jobs_completed: completed,
    jobs_cancelled: cancelled,
    offered,
    accepted,
    acceptance_rate: offered ? Math.round((accepted/offered)*100) : 50,
    completion_rate: accepted ? Math.round((completed/accepted)*100) : 50,
    avg_rating: Math.round(avgRating*100)/100,
    verified_document_types: [...new Set(verifiedDocs.map(d=>d.doc_type))],
    quality_points: Number((qualityRows && qualityRows.points) || 0),
  };
}

async function professionalScore(contractorId) {
  const m = await contractorMetrics(contractorId);
  if (!m) return null;
  const c = m.contractor;

  const quality = m.avg_rating
    ? clamp(((m.avg_rating - 3) / 2) * 100)
    : 55;
  const acceptance = clamp(m.acceptance_rate);
  const completion = clamp(m.completion_rate);

  const complianceParts = [
    !!c.license_verified,
    !!c.insurance_verified,
    c.background_check === 'passed',
  ];
  const compliance = Math.round(complianceParts.filter(Boolean).length / complianceParts.length * 100);

  const volume = clamp(m.jobs_completed * 8, 30, 100);
  const qualityAdjust = clamp(50 + m.quality_points, 0, 100);

  const weights = {
    quality: 0.30,
    completion: 0.22,
    acceptance: 0.13,
    compliance: 0.20,
    experience_volume: 0.08,
    quality_events: 0.07,
  };

  const parts = {
    quality,
    completion,
    acceptance,
    compliance,
    experience_volume: volume,
    quality_events: qualityAdjust,
  };

  let score = 0;
  for (const [k,w] of Object.entries(weights)) score += parts[k] * w;

  const blockers = [];
  if (!c.license_verified) blockers.push('license_not_verified');
  if (!c.insurance_verified) blockers.push('insurance_not_verified');
  if (c.background_check !== 'passed') blockers.push('background_not_passed');
  if (c.status !== 'active') blockers.push('account_not_active');

  return {
    score: Math.round(score),
    eligible_for_matching: blockers.length === 0,
    blockers,
    parts,
    metrics: m,
    weights,
  };
}

module.exports = { contractorMetrics, professionalScore };
