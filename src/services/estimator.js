// REAL estimation engine (deterministic, explainable — nothing hardcoded per job).
// Takes: service type, urgency, US state, scope-questionnaire answers, photo count.
// Returns: price range, line-item breakdown, missing info, risk flags, confidence,
// and human-readable factors explaining what moved the price.
//
// Money is integer CENTS. All numbers are US 2026 planning figures for a
// managed handyman marketplace (platform quotes customer, pays contractor).
const ENGINE_VERSION = '1.0';

// Labor cost multiplier by state (rough). Unknown states fall back to 1.0.
const REGION_MULTIPLIER = {
  CA: 1.18, NY: 1.22, WA: 1.12, MA: 1.15, NJ: 1.14, CT: 1.12, HI: 1.25, AK: 1.2,
  TX: 0.95, FL: 0.97, AZ: 0.96, NV: 1.0, OR: 1.05, CO: 1.02, IL: 1.05,
};

const URGENCY_MULTIPLIER = { standard: 1.0, urgent: 1.25 };

// Trade catalog. Each trade: base mobilization range + scalable drivers +
// option multipliers + risk rules + required scope questions.
const TRADES = {
  painting: {
    label: 'Painting',
    base: { low_cents: 60000, high_cents: 100000, label: 'Mobilization, setup and base materials' },
    questions: [
      { key: 'area_sqft', label: 'Area to paint (sq ft of wall)', type: 'number', required: true, min: 10, max: 20000 },
      { key: 'ceilings', label: 'Include ceilings?', type: 'boolean', required: false },
      { key: 'wall_condition', label: 'Wall condition', type: 'select', options: ['good', 'fair', 'poor'], required: true },
      { key: 'paint_quality', label: 'Paint quality', type: 'select', options: ['standard', 'premium'], required: false },
      { key: 'home_year', label: 'Home built year', type: 'number', required: false, min: 1800, max: 2026 },
    ],
    drivers: [
      { key: 'area_sqft', label: 'Painting labor and paint', low_cents: 220, high_cents: 380, per: 'sqft' },
    ],
    options: [
      { when: a => a.ceilings === true, mult: 1.18, note: 'Ceilings included (+18%)' },
      { when: a => a.paint_quality === 'premium', mult: 1.12, note: 'Premium paint (+12%)' },
      { when: a => a.wall_condition === 'poor', mult: 1.15, note: 'Poor wall condition, extra prep (+15%)' },
    ],
    risks: [
      { when: a => a.home_year && a.home_year < 1978, flag: 'lead_paint', note: 'Home pre-dates 1978: lead paint test may be legally required.', contingency: 0.10 },
      { when: a => a.wall_condition === 'poor', flag: 'skim_coat', note: 'Poor walls may need skim coating once opened up.', contingency: 0.08 },
    ],
  },
  plumbing: {
    label: 'Plumbing',
    base: { low_cents: 18000, high_cents: 32000, label: 'Service call and diagnostic' },
    questions: [
      { key: 'issue_type', label: 'Issue type', type: 'select', options: ['leak', 'clog', 'fixture_install', 'water_heater', 'rough_in'], required: true },
      { key: 'fixtures', label: 'Number of fixtures involved', type: 'number', required: false, min: 1, max: 20 },
      { key: 'access', label: 'Access to the work area', type: 'select', options: ['easy', 'tight', 'concealed'], required: true },
      { key: 'home_year', label: 'Home built year', type: 'number', required: false, min: 1800, max: 2026 },
    ],
    drivers: [
      { key: 'fixtures', label: 'Fixture work', low_cents: 22000, high_cents: 48000, per: 'each' },
      { key: 'water_heater', label: 'Water heater replacement', low_cents: 140000, high_cents: 240000, per: 'job', when: a => a.issue_type === 'water_heater' },
      { key: 'rough_in', label: 'Rough-in plumbing', low_cents: 180000, high_cents: 350000, per: 'job', when: a => a.issue_type === 'rough_in' },
    ],
    options: [
      { when: a => a.access === 'tight', mult: 1.12, note: 'Tight access (+12%)' },
      { when: a => a.access === 'concealed', mult: 1.25, note: 'Concealed pipes, wall/ceiling opening (+25%)' },
    ],
    risks: [
      { when: a => a.access === 'concealed', flag: 'open_wall', note: 'Concealed work may reveal additional damage once opened.', contingency: 0.15 },
      { when: a => a.home_year && a.home_year < 1980, flag: 'galvanized', note: 'Pre-1980 homes may have galvanized steel pipes needing replacement.', contingency: 0.10 },
      { when: a => a.issue_type === 'water_heater', flag: 'permit', note: 'Water heater replacement usually requires a permit and haul-away.', contingency: 0.08 },
    ],
  },
  electrical: {
    label: 'Electrical',
    base: { low_cents: 20000, high_cents: 35000, label: 'Service call and diagnostic' },
    questions: [
      { key: 'work_type', label: 'Work type', type: 'select', options: ['outlets_switches', 'lighting', 'ceiling_fan', 'panel_upgrade', 'troubleshoot'], required: true },
      { key: 'count', label: 'Number of devices/fixtures', type: 'number', required: false, min: 1, max: 60 },
      { key: 'panel_age', label: 'Electrical panel age (years)', type: 'number', required: false, min: 0, max: 80 },
      { key: 'home_year', label: 'Home built year', type: 'number', required: false, min: 1800, max: 2026 },
    ],
    drivers: [
      { key: 'count', label: 'Device installation', low_cents: 18000, high_cents: 32000, per: 'each' },
      { key: 'panel', label: 'Panel upgrade', low_cents: 220000, high_cents: 450000, per: 'job', when: a => a.work_type === 'panel_upgrade' },
    ],
    options: [],
    risks: [
      { when: a => a.home_year && a.home_year < 1975, flag: 'aluminum', note: 'Pre-1975 wiring may be aluminum and need special remediation.', contingency: 0.12 },
      { when: a => a.panel_age && a.panel_age > 25 && a.work_type !== 'panel_upgrade', flag: 'old_panel', note: 'Panel older than 25 years may need an upgrade to support new load.', contingency: 0.10 },
    ],
  },
  bathroom: {
    label: 'Bathroom remodel',
    base: { low_cents: 750000, high_cents: 1200000, label: 'Base remodel (demo, rough, finish, cleanup)' },
    questions: [
      { key: 'area_sqft', label: 'Bathroom floor area (sq ft)', type: 'number', required: true, min: 15, max: 400 },
      { key: 'plumbing_relocation', label: 'Moving any plumbing (toilet, shower, sink)?', type: 'boolean', required: true },
      { key: 'tile_level', label: 'Tile/finish level', type: 'select', options: ['standard', 'premium'], required: false },
      { key: 'fixture_selection', label: 'Fixtures already selected?', type: 'boolean', required: false },
    ],
    drivers: [
      { key: 'area_sqft', label: 'Area beyond 40 sq ft', low_cents: 12000, high_cents: 22000, per: 'sqft', baseQty: 40 },
      { key: 'relocation', label: 'Plumbing relocation', low_cents: 180000, high_cents: 350000, per: 'job', when: a => a.plumbing_relocation === true },
    ],
    options: [
      { when: a => a.tile_level === 'premium', mult: 1.15, note: 'Premium tile and finishes (+15%)' },
    ],
    risks: [
      { when: () => true, flag: 'water_damage', note: 'Bathrooms often hide water damage found only after demolition.', contingency: 0.15 },
      { when: a => a.plumbing_relocation === true, flag: 'permit', note: 'Plumbing relocation requires permits and inspection.', contingency: 0.08 },
    ],
  },
  kitchen: {
    label: 'Kitchen remodel (partial)',
    base: { low_cents: 1200000, high_cents: 2200000, label: 'Base remodel labor and project management' },
    questions: [
      { key: 'cabinets_lf', label: 'Cabinets (linear feet)', type: 'number', required: false, min: 1, max: 120 },
      { key: 'countertop_sqft', label: 'Countertop (sq ft)', type: 'number', required: false, min: 1, max: 200 },
      { key: 'appliances', label: 'Appliances to install', type: 'number', required: false, min: 0, max: 10 },
      { key: 'layout_change', label: 'Changing the layout (walls, plumbing, gas)?', type: 'boolean', required: true },
    ],
    drivers: [
      { key: 'cabinets_lf', label: 'Cabinetry', low_cents: 18000, high_cents: 35000, per: 'linear ft' },
      { key: 'countertop_sqft', label: 'Countertop', low_cents: 6000, high_cents: 14000, per: 'sqft' },
      { key: 'appliances', label: 'Appliance installation', low_cents: 25000, high_cents: 50000, per: 'each' },
    ],
    options: [],
    risks: [
      { when: a => a.layout_change === true, flag: 'structural', note: 'Layout changes may need structural review and permits.', contingency: 0.12 },
      { when: () => true, flag: 'panel_capacity', note: 'Added appliances may exceed electrical panel capacity.', contingency: 0.08 },
    ],
  },
  flooring: {
    label: 'Flooring',
    base: { low_cents: 50000, high_cents: 90000, label: 'Mobilization, removal and disposal' },
    questions: [
      { key: 'area_sqft', label: 'Floor area (sq ft)', type: 'number', required: true, min: 20, max: 10000 },
      { key: 'material', label: 'Material', type: 'select', options: ['laminate', 'vinyl', 'lvt', 'hardwood', 'tile'], required: true },
      { key: 'moisture_area', label: 'Bathroom, kitchen or basement?', type: 'boolean', required: false },
    ],
    drivers: [
      { key: 'area_sqft', label: 'Material + installation', low_cents: 450, high_cents: 1100, per: 'sqft' },
    ],
    options: [
      { when: a => a.material === 'hardwood', mult: 1.6, note: 'Hardwood material (+60%)' },
      { when: a => a.material === 'tile', mult: 1.5, note: 'Tile material and labor (+50%)' },
      { when: a => a.material === 'lvt', mult: 1.1, note: 'LVT material (+10%)' },
    ],
    risks: [
      { when: () => true, flag: 'subfloor', note: 'Subfloor damage is only visible after old flooring is removed.', contingency: 0.10 },
      { when: a => a.moisture_area === true, flag: 'moisture', note: 'Moisture-prone areas may need underlayment upgrades.', contingency: 0.08 },
    ],
  },
  drywall: {
    label: 'Drywall',
    base: { low_cents: 35000, high_cents: 60000, label: 'Mobilization and setup' },
    questions: [
      { key: 'area_sqft', label: 'Repair area (sq ft)', type: 'number', required: true, min: 4, max: 5000 },
      { key: 'texture_match', label: 'Need texture matching?', type: 'boolean', required: false },
    ],
    drivers: [
      { key: 'area_sqft', label: 'Hang, tape, mud and sand', low_cents: 280, high_cents: 520, per: 'sqft' },
    ],
    options: [
      { when: a => a.texture_match === true, mult: 1.12, note: 'Texture matching (+12%)' },
    ],
    risks: [
      { when: a => a.area_sqft > 200, flag: 'seams', note: 'Large patches risk visible seams; skim coat recommended.', contingency: 0.05 },
    ],
  },
  carpentry: {
    label: 'Carpentry',
    base: { low_cents: 40000, high_cents: 75000, label: 'Mobilization and first half-day' },
    questions: [
      { key: 'trim_lf', label: 'Trim/molding (linear feet)', type: 'number', required: false, min: 1, max: 2000 },
      { key: 'doors', label: 'Doors to hang', type: 'number', required: false, min: 0, max: 30 },
      { key: 'custom', label: 'Custom millwork or built-ins?', type: 'boolean', required: false },
    ],
    drivers: [
      { key: 'trim_lf', label: 'Trim installation', low_cents: 600, high_cents: 1200, per: 'linear ft' },
      { key: 'doors', label: 'Door hanging', low_cents: 28000, high_cents: 55000, per: 'each' },
    ],
    options: [],
    risks: [
      { when: a => a.custom === true, flag: 'lead_time', note: 'Custom millwork adds material lead time.', contingency: 0.08 },
    ],
  },
};

function round50(cents) {
  return Math.round(cents / 5000) * 5000;
}

// Main entry: returns { low_cents, high_cents, line_items, missing, risks, confidence, factors }
function estimateJob({ service_type, urgency = 'standard', state = '', scope = {}, photoCount = 0 }) {
  const trade = TRADES[service_type];
  if (!trade) throw new Error('Unknown service_type: ' + service_type);

  const a = scope || {};
  const missing = [];
  const factors = [];
  const lineItems = [];

  // 1. Required-question check -> missing info list.
  for (const q of trade.questions) {
    const v = a[q.key];
    const empty = v === undefined || v === null || v === '';
    if (q.required && empty) missing.push({ key: q.key, label: q.label });
  }

  // 2. Base line item.
  let low = trade.base.low_cents;
  let high = trade.base.high_cents;
  lineItems.push({ label: trade.base.label, low_cents: low, high_cents: high });

  // 3. Scalable drivers.
  for (const d of trade.drivers) {
    if (d.when && !d.when(a)) continue;
    let qty = Number(a[d.key]);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    if (d.baseQty) qty = Math.max(0, qty - d.baseQty);
    if (qty <= 0) continue;
    const dl = Math.round(d.low_cents * qty);
    const dh = Math.round(d.high_cents * qty);
    low += dl; high += dh;
    lineItems.push({ label: `${d.label} (${qty} ${d.per})`, low_cents: dl, high_cents: dh });
    factors.push(`${d.label}: ${qty} ${d.per} scaled at $${(d.low_cents / 100).toFixed(2)}–$${(d.high_cents / 100).toFixed(2)} per ${d.per}.`);
  }

  // 4. Option multipliers.
  for (const o of trade.options) {
    if (o.when(a)) {
      low = Math.round(low * o.mult);
      high = Math.round(high * o.mult);
      factors.push(o.note + '.');
    }
  }

  // 5. Urgency + region.
  const uMult = URGENCY_MULTIPLIER[urgency] || 1.0;
  if (uMult !== 1.0) factors.push(`Urgency "${urgency}" ×${uMult.toFixed(2)}.`);
  const rMult = REGION_MULTIPLIER[(state || '').toUpperCase()] || 1.0;
  if (rMult !== 1.0) factors.push(`Region ${(state || '').toUpperCase()} labor ×${rMult.toFixed(2)}.`);
  low = Math.round(low * uMult * rMult);
  high = Math.round(high * uMult * rMult);

  // 6. Risk flags -> contingency widens the HIGH end only.
  const risks = [];
  let contingency = 0;
  for (const r of trade.risks) {
    if (r.when(a)) {
      risks.push({ flag: r.flag, note: r.note });
      contingency += r.contingency;
      factors.push(`Risk "${r.flag}": +${Math.round(r.contingency * 100)}% contingency on the high end.`);
    }
  }
  high = Math.round(high * (1 + contingency));

  // 7. Confidence: starts at 85, loses for gaps, gains for photos.
  let confidence = 85;
  confidence -= missing.length * 10;
  confidence -= risks.length * 5;
  confidence += Math.min(10, photoCount * 5);
  confidence = Math.max(30, Math.min(95, confidence));
  if (photoCount > 0) factors.push(`${photoCount} photo(s) attached: improves confidence.`);
  if (missing.length) factors.push(`${missing.length} required answer(s) missing: range widened, confidence reduced.`);

  return {
    low_cents: round50(low),
    high_cents: round50(high),
    line_items: lineItems.map(li => ({ ...li, low_cents: round50(li.low_cents), high_cents: round50(li.high_cents) })),
    missing,
    risks,
    confidence,
    factors,
    engine_version: ENGINE_VERSION,
    trade_label: trade.label,
  };
}

// Questionnaire metadata for the frontend (no prices exposed).
function tradeQuestionnaire(service_type) {
  const t = TRADES[service_type];
  if (!t) return null;
  return { service_type, label: t.label, questions: t.questions };
}

module.exports = { TRADES, estimateJob, tradeQuestionnaire, ENGINE_VERSION };
