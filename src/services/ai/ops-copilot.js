'use strict';

/**
 * AI operations layer.
 *
 * Guardrails:
 * - AI does not autonomously change prices, assign contractors, charge cards,
 *   issue refunds, suspend contractors or send campaigns.
 * - AI generates recommendations. A deterministic route/service executes actions
 *   only after a human or explicit business rule approves them.
 */

function leadRecommendation(job, quote) {
  const ageHours = job.created_at
    ? (Date.now() - new Date(job.created_at).getTime()) / 3_600_000
    : 0;

  if (quote?.status === 'sent' && ageHours > 48) {
    return {
      kind: 'sales_followup',
      priority: 'high',
      title: 'Follow up on open quote',
      explanation: `Quote has been open for more than ${Math.floor(ageHours)} hours.`,
      action: { type: 'create_followup_task', job_request_id: job.id },
    };
  }

  if (job.urgency === 'urgent' && job.status === 'new') {
    return {
      kind: 'lead_priority',
      priority: 'high',
      title: 'Urgent lead needs immediate review',
      explanation: 'Customer marked the request urgent and no quote has been sent.',
      action: { type: 'open_job', job_request_id: job.id },
    };
  }

  return null;
}

function dispatchRecommendation(project, rankedContractors) {
  const top = rankedContractors?.[0];
  if (!top) {
    return {
      kind: 'dispatch',
      priority: 'critical',
      title: 'No eligible contractor found',
      explanation: 'No verified contractor currently satisfies matching guardrails.',
      action: { type: 'expand_search', project_id: project.id },
    };
  }

  return {
    kind: 'dispatch',
    priority: top.match.score >= 85 ? 'medium' : 'high',
    title: `Recommended contractor: ${top.contractor.legal_name || top.contractor.name}`,
    explanation: `Match score ${top.match.score}/100 based on specialty, distance, rating, workload, compliance and performance.`,
    confidence: top.match.score,
    action: {
      type: 'offer_project',
      project_id: project.id,
      contractor_id: top.contractor.id,
    },
  };
}

function marginRecommendation(financials, project) {
  if (financials.gross_margin_pct < 20) {
    return {
      kind: 'margin_risk',
      priority: 'high',
      title: 'Low projected margin',
      explanation: `Projected gross margin is ${financials.gross_margin_pct}%. Review scope, contractor cost and change-order exposure.`,
      action: { type: 'review_project_financials', project_id: project.id },
    };
  }
  return null;
}

function compileRecommendations(ctx) {
  return [
    leadRecommendation(ctx.job || {}, ctx.quote),
    dispatchRecommendation(ctx.project || {}, ctx.rankedContractors || []),
    ctx.financials && ctx.project ? marginRecommendation(ctx.financials, ctx.project) : null,
  ].filter(Boolean);
}

module.exports = {
  leadRecommendation,
  dispatchRecommendation,
  marginRecommendation,
  compileRecommendations,
};
