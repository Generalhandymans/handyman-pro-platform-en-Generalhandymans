'use strict';

const db = require('../db');
const crypto = require('crypto');

const API_KEY = process.env.OPENAI_API_KEY || '';
const BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const MODEL = process.env.OPENAI_SCOPE_MODEL || process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini';

function providerMode() {
  return API_KEY ? 'openai_compatible' : 'heuristic';
}

function safeJson(text, fallback={}) {
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < start) return fallback;
    return JSON.parse(text.slice(start, end + 1));
  } catch (_) {
    return fallback;
  }
}

function classifyRisk({ service_type, description, scope={}, vision={} }) {
  const txt = `${service_type || ''} ${description || ''} ${JSON.stringify(scope)} ${JSON.stringify(vision)}`.toLowerCase();
  const flags = [];

  const push = (flag, note, severity='medium', kind='safety') => {
    if (!flags.some(x => x.flag === flag)) flags.push({ flag, note, severity, kind });
  };

  if (/(panel|breaker|wire|wiring|electrical|outlet|circuit|220v|240v)/.test(txt))
    push('electrical_work','Electrical work may require licensed-trade review and permit verification.','high','license');
  if (/(gas line|gas leak|gas appliance|natural gas|propane)/.test(txt))
    push('gas_work','Gas-related work requires qualified professional review.','critical','license');
  if (/(load bearing|structural|foundation|beam|remove wall|bearing wall)/.test(txt))
    push('structural_change','Possible structural scope requires human review and may require permits/engineering.','high','permit');
  if (/(roof|roofing|flashing)/.test(txt))
    push('roof_work','Roof work may have fall-protection, licensing, and permit considerations.','high','safety');
  if (/(mold|asbestos|lead paint|lead-based|hazardous)/.test(txt))
    push('hazardous_material','Potential hazardous-material condition requires specialized review; do not disturb based on AI guidance.','critical','safety');
  if (/(water heater|plumbing relocation|rough.?in|sewer|main line)/.test(txt))
    push('plumbing_permit_review','Plumbing scope may require permit/licensed-trade review.','high','permit');
  if (/(flood|active leak|sparking|smoke|burning smell|collapse)/.test(txt))
    push('urgent_safety_signal','Description suggests a condition that may need immediate professional/emergency assessment.','critical','safety');

  const max = {low:0,medium:1,high:2,critical:3};
  let severity='low';
  for (const f of flags) if (max[f.severity] > max[severity]) severity=f.severity;

  return {
    severity,
    flags,
    requires_human_review: ['high','critical'].includes(severity),
    requires_license_review: flags.some(f => f.kind === 'license'),
    requires_permit_review: flags.some(f => f.kind === 'permit'),
  };
}

function completenessScore(job, scope={}, vision={}) {
  let score = 30;
  if (job.address && job.zip) score += 10;
  if ((job.description || '').trim().length >= 50) score += 10;
  const keys = Object.keys(scope || {}).filter(k => scope[k] !== '' && scope[k] !== null && scope[k] !== undefined);
  score += Math.min(25, keys.length * 5);
  if (vision && Array.isArray(vision.observations) && vision.observations.length) score += 15;
  if (vision && Array.isArray(vision.risks) && vision.risks.some(r => r.flag === 'vision_unavailable')) score -= 10;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function heuristicScope(job, scope={}, vision={}) {
  const missing = [];
  if (!job.zip) missing.push('zip');
  if (!job.description || job.description.trim().length < 50) missing.push('detailed_description');
  if (!Object.keys(scope || {}).length) missing.push('scope_questions');
  return {
    service_type: job.service_type,
    summary: job.description || '',
    room_or_area: vision.room_hint || scope.room_type || null,
    scope,
    observations: vision.observations || [],
    missing_information: missing,
    assumptions: [],
    suggested_questions: missing.map(x => `Please clarify: ${x.replaceAll('_',' ')}.`),
  };
}

async function llmScope(job, scope={}, vision={}) {
  const prompt = {
    role: 'system',
    content:
      'You are HELPMAN Scope Builder for a managed US home-services platform. ' +
      'Return JSON only. Be conservative. Do not diagnose hidden conditions, promise licensing, or provide legal conclusions. ' +
      'Convert homeowner language into a structured scope useful for estimating and dispatch. ' +
      'Schema: {"summary":"","work_items":[{"action":"","object":"","quantity":null,"unit":null}],"room_or_area":null,' +
      '"conditions_visible":[],"missing_information":[],"suggested_questions":[],"assumptions":[],"trade_hints":[]}.'
  };
  const user = {
    role: 'user',
    content: JSON.stringify({
      service_type: job.service_type,
      description: job.description,
      city: job.city, state: job.state, zip: job.zip,
      customer_scope: scope,
      vision_observations: vision.observations || [],
      vision_room_hint: vision.room_hint || null,
      vision_risks: vision.risks || [],
    })
  };

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {'Content-Type':'application/json', Authorization:`Bearer ${API_KEY}`},
    body: JSON.stringify({model:MODEL,messages:[prompt,user],temperature:0.1,max_tokens:900})
  });
  if (!res.ok) throw new Error(`scope provider ${res.status}`);
  const data = await res.json();
  const out = safeJson(data?.choices?.[0]?.message?.content || '{}', {});
  return out && typeof out === 'object' ? out : {};
}

async function recordRun({ kind, jobId=null, projectId=null, provider, model=null, inputSummary='', output={}, confidence=null, status='completed', errorCode=null, durationMs=null }) {
  try {
    const info = await db.prepare(
      `INSERT INTO ai_runs
       (kind,provider,model,job_request_id,project_id,input_summary,output_json,confidence,status,error_code,duration_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(kind,provider,model,jobId,projectId,inputSummary.slice(0,1500),JSON.stringify(output),confidence,status,errorCode,durationMs);
    return info.lastInsertRowid;
  } catch (_) { return null; }
}

async function buildScope(job, customerScope={}, vision={}) {
  const started = Date.now();
  const provider = providerMode();
  let output, status='completed', errorCode=null;

  if (API_KEY) {
    try {
      output = await llmScope(job, customerScope, vision);
    } catch (e) {
      output = heuristicScope(job, customerScope, vision);
      status='fallback';
      errorCode=String(e.message).slice(0,120);
    }
  } else {
    output = heuristicScope(job, customerScope, vision);
    status='fallback';
  }

  const risk = classifyRisk({service_type:job.service_type,description:job.description,scope:customerScope,vision});
  const completeness = completenessScore(job, customerScope, vision);
  const confidence = Math.max(0, Math.min(100, completeness - (risk.requires_human_review ? 15 : 0)));

  const result = {
    ...output,
    risk,
    confidence,
    planning_only: true,
    human_review_required: risk.requires_human_review || confidence < 60,
    engine_version: 'helpman-intelligence-1.0',
  };

  await recordRun({
    kind:'scope_builder',jobId:job.id,provider,model:API_KEY?MODEL:null,
    inputSummary:`${job.service_type}: ${(job.description||'').slice(0,500)}`,
    output:result,confidence,status,errorCode,durationMs:Date.now()-started
  });
  return result;
}

module.exports = {
  providerMode, classifyRisk, completenessScore, buildScope, recordRun
};
