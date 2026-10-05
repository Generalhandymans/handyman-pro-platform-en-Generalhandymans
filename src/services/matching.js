'use strict';

/**
 * Explainable contractor matching.
 *
 * The scoring intentionally keeps business rules deterministic.
 * AI may summarize the recommendation, but AI does not decide assignment.
 */

function clamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, n));
}

function specialtyScore(contractor, serviceType) {
  const s = Array.isArray(contractor.specialties)
    ? contractor.specialties
    : (() => {
        try { return JSON.parse(contractor.specialties || '[]'); }
        catch { return String(contractor.specialties || '').split(',').map(x => x.trim()); }
      })();
  return s.includes(serviceType) ? 100 : 20;
}

function distanceScore(distanceMiles, radiusMiles = 25) {
  if (distanceMiles == null) return 45;
  if (distanceMiles > radiusMiles) return 0;
  return clamp(100 - (distanceMiles / Math.max(radiusMiles, 1)) * 100);
}

function ratingScore(rating) {
  const r = Number(rating || 0);
  if (!r) return 45;
  return clamp(((r - 3) / 2) * 100);
}

function availabilityScore(c) {
  if (c.is_available === false) return 0;
  const workload = Number(c.current_workload || 0);
  return clamp(100 - workload * 15);
}

function complianceScore(c) {
  if (!c.license_verified || !c.insurance_verified || c.background_check !== 'passed') return 0;
  return 100;
}

function marginScore(project, contractor) {
  const customer = Number(project.customer_price_cents || 0);
  const expectedCost = Number(
    contractor.expected_cost_cents ||
    project.contractor_cost_cents ||
    0
  );
  if (!customer || !expectedCost) return 50;
  const margin = (customer - expectedCost) / customer;
  return clamp((margin / 0.40) * 100);
}

function matchContractor(project, contractor, options = {}) {
  const weights = {
    specialty: 0.24,
    distance: 0.18,
    rating: 0.15,
    availability: 0.16,
    compliance: 0.15,
    acceptance: 0.05,
    completion: 0.04,
    margin: 0.03,
    ...options.weights,
  };

  const parts = {
    specialty: specialtyScore(contractor, project.service_type),
    distance: distanceScore(contractor.distance_miles, contractor.service_radius_miles),
    rating: ratingScore(contractor.rating_avg),
    availability: availabilityScore(contractor),
    compliance: complianceScore(contractor),
    acceptance: clamp(Number(contractor.acceptance_rate || 50)),
    completion: clamp(Number(contractor.completion_rate || 50)),
    margin: marginScore(project, contractor),
  };

  // Hard compliance guardrail.
  if (parts.compliance === 0) {
    return {
      eligible: false,
      score: 0,
      parts,
      reason: 'Contractor is not fully verified for license, insurance and background check.',
    };
  }

  let score = 0;
  for (const [k, weight] of Object.entries(weights)) {
    score += (parts[k] || 0) * weight;
  }

  return {
    eligible: true,
    score: Math.round(score * 10) / 10,
    parts,
    explanation: {
      strongest: Object.entries(parts).sort((a,b)=>b[1]-a[1]).slice(0,3),
      weakest: Object.entries(parts).sort((a,b)=>a[1]-b[1]).slice(0,3),
    },
  };
}

function rankContractors(project, contractors, options) {
  return contractors
    .map(c => ({ contractor: c, match: matchContractor(project, c, options) }))
    .filter(x => x.match.eligible)
    .sort((a, b) => b.match.score - a.match.score);
}

module.exports = {
  matchContractor,
  rankContractors,
  specialtyScore,
  distanceScore,
};
