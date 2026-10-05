// Seed: coherent demo data across the whole lifecycle (both sides).
// Run: SEED_DEMO=true npm run seed
// SECURITY: this file creates a demo admin with KNOWN credentials. It REFUSES
// to run unless SEED_DEMO=true is set explicitly, so production databases
// never get demo accounts by accident. In production, create the real admin
// via ADMIN_EMAIL + ADMIN_PASSWORD (see server.js first-boot).
require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('./db');
const { estimateJob } = require('./services/estimator');
const crm = require('./services/crm');

if (process.env.SEED_DEMO !== 'true') {
  console.error('Refusing to seed: set SEED_DEMO=true to load demo data explicitly.');
  console.error('For production, set ADMIN_EMAIL and ADMIN_PASSWORD instead (server.js creates the admin on first boot).');
  process.exit(1);
}

if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) {
  console.log('Database already has users — skipping seed.');
  process.exit(0);
}

const pw = p => bcrypt.hashSync(p, 10);
// Demo credentials come from env when provided (CI, staging); otherwise the
// well-known demo values below — NEVER use these in production.
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@generalhandymansolutions.test';
const ADMIN_PW = process.env.ADMIN_PASSWORD || 'Admin123!';
const CUST_PW = 'Customer123!';
const CONT_PW = 'Contractor123!';

const addUser = (name, email, phone, role, password) =>
  db.prepare('INSERT INTO users (name, email, phone, password_hash, role) VALUES (?,?,?,?,?)')
    .run(name, email, phone, pw(password), role).lastInsertRowid;

// ---------------- users ----------------
const adminId = addUser('Dana Admin', ADMIN_EMAIL, '555-010-0001', 'admin', ADMIN_PW);
db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(adminId);

const customers = [
  ['Maya Thompson', 'maya.t@example.com', '555-201-0001'],
  ['Luis Herrera', 'luis.h@example.com', '555-201-0002'],
  ['Priya Nair', 'priya.n@example.com', '555-201-0003'],
  ['Tom Becker', 'tom.b@example.com', '555-201-0004'],
  ['Aisha Khan', 'aisha.k@example.com', '555-201-0005'],
  ['Greg Olson', 'greg.o@example.com', '555-201-0006'],
  ['Nina Rossi', 'nina.r@example.com', '555-201-0007'],
].map(([n, e, p]) => ({ id: addUser(n, e, p, 'customer', CUST_PW), name: n, email: e, phone: p }));

const contractors = [
  // [name, email, legal, city, specialties, years, license, insurance, verified?, bg, status, rating, jobs]
  ['Carlos Mendez', 'carlos.m@example.com', 'Mendez Plumbing LLC', 'Fairfield', 'plumbing', 9, 'C36-882101', 'Hiscox PL $1M', 1, 'passed', 'active', 4.8, 14],
  ['Dana Whitfield', 'dana.w@example.com', 'Whitfield Paint Co.', 'Benicia', 'painting,drywall', 12, 'C33-771204', 'Next PL $2M', 1, 'passed', 'active', 4.6, 9],
  ['Rosa Jimenez', 'rosa.j@example.com', 'RJ Electric', 'Vacaville', 'electrical', 7, 'C10-553190', 'Hartford PL $1M', 1, 'passed', 'active', 4.1, 5],
  ['Sam Porter', 'sam.p@example.com', 'Porter Floors', 'Napa', 'flooring,carpentry', 6, 'C15-209811', 'Travelers PL $1M', 0, 'pending', 'pending', 0, 0],
  ['Elena Vasquez', 'elena.v@example.com', 'Vasquez Remodeling', 'Suisun City', 'bathroom,kitchen', 11, 'B-1042291', 'Liberty PL $2M', 1, 'pending', 'pending', 0, 0],
  ['Mike Dalton', 'mike.d@example.com', 'Dalton Handyman', 'Concord', 'carpentry,painting', 4, '', '', 0, 'failed', 'suspended', 2.9, 3],
].map(([name, email, legal, city, spec, yrs, lic, ins, ver, bg, status, rating, jobs]) => {
  const uid = addUser(name, email, '555-301-0001', 'contractor', CONT_PW);
  const id = db.prepare(
    `INSERT INTO contractors (user_id, legal_name, city, service_base, years_experience, specialties,
      license_number, insurance_info, license_verified, insurance_verified, background_check, status, rating_avg, jobs_completed)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(uid, legal, city, city, yrs, spec, lic, ins, ver, ver, bg, status, rating, jobs).lastInsertRowid;
  return { id, uid, name, email, specialties: spec, status, rating_avg: rating, jobs_completed: jobs,
    license_verified: ver, insurance_verified: ver, background_check: bg };
});

// ---------------- job requests ----------------
// [customerIdx, service, urgency, state, city, status, daysAgo, scope, description]
const jobDefs = [
  [0, 'bathroom', 'standard', 'CA', 'Fairfield', 'completed', 120,
    { area_sqft: 55, plumbing_relocation: false, tile_level: 'standard', fixture_selection: true },
    'Guest bathroom remodel: old tub out, walk-in shower in. Tile floor already picked.'],
  [1, 'painting', 'standard', 'CA', 'Suisun City', 'completed', 100,
    { area_sqft: 900, ceilings: true, wall_condition: 'fair', paint_quality: 'premium', home_year: 1998 },
    'Full interior repaint, 3 bed 2 bath. Walls fair, some nail holes.'],
  [2, 'plumbing', 'urgent', 'CA', 'Benicia', 'completed', 75,
    { issue_type: 'leak', fixtures: 1, access: 'tight', home_year: 1975 },
    'Kitchen sink supply line leaking under cabinet. Need it fixed ASAP.'],
  [3, 'electrical', 'standard', 'CA', 'Vacaville', 'review', 6,
    { work_type: 'outlets_switches', count: 8, panel_age: 12, home_year: 2005 },
    'Add 6 outlets in home office plus 2 USB outlets in bedrooms.'],
  [4, 'flooring', 'standard', 'CA', 'Napa', 'in_progress', 12,
    { area_sqft: 650, material: 'lvt', moisture_area: false },
    'Replace carpet with LVT in living room and hallway.'],
  [5, 'painting', 'urgent', 'CA', 'Fairfield', 'quote_sent', 3,
    { area_sqft: 450, ceilings: false, wall_condition: 'good', paint_quality: 'standard' },
    'Two bedrooms and hallway need fresh paint before tenants move in Friday.'],
  [6, 'drywall', 'standard', 'CA', 'Benicia', 'quote_sent', 4,
    { area_sqft: 60, texture_match: true },
    'Water damage repair in ceiling after roof leak fixed. Need texture match.'],
  [0, 'carpentry', 'standard', 'CA', 'Fairfield', 'ai_analyzed', 1,
    { trim_lf: 120, doors: 2, custom: false },
    'Install new baseboards throughout downstairs and hang 2 interior doors.'],
  [1, 'kitchen', 'standard', 'CA', 'Suisun City', 'new', 0,
    { cabinets_lf: 18, countertop_sqft: 45, appliances: 2, layout_change: false },
    'Refresh kitchen: reface cabinets, new quartz counters, install dishwasher and range.'],
  [2, 'plumbing', 'standard', 'CA', 'Benicia', 'new', 2,
    { issue_type: 'clog', access: 'easy' },
    'Bathroom sink draining very slowly, tried plunger already.'],
  [3, 'electrical', 'standard', 'CA', 'Vacaville', 'lost', 40,
    { work_type: 'panel_upgrade', panel_age: 35, home_year: 1988 },
    '200A panel upgrade quote requested.'],
  [4, 'bathroom', 'standard', 'CA', 'Napa', 'completed', 200,
    { area_sqft: 48, plumbing_relocation: true, tile_level: 'premium', fixture_selection: true },
    'Master bath full remodel done last year — INACTIVE 200 days (reactivation segment).'],
];

const jobs = [];
for (const [ci, service, urgency, state, city, status, daysAgo, scope, desc] of jobDefs) {
  const cu = customers[ci];
  const created = new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const info = db.prepare(
    `INSERT INTO job_requests (customer_id, name, phone, email, address, city, state, zip,
      service_type, urgency, description, scope_json, status, claim_token, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(cu.id, cu.name, cu.phone, cu.email, `${100 + jobs.length} Main St`, city, state, '94533',
    service, urgency, desc, JSON.stringify(scope), status,
    require('crypto').randomBytes(16).toString('hex'), created, created);
  const job = db.prepare('SELECT * FROM job_requests WHERE id = ?').get(info.lastInsertRowid);
  jobs.push(job);
  crm.refreshLeadScore(job.id);
}

// Photos on a couple of jobs (1x1 png stand-ins).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const fs = require('fs'), path = require('path');
const upDir = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(upDir, { recursive: true });
for (const jid of [jobs[7].id, jobs[8].id]) {
  const fn = `seed-${jid}-1.png`;
  fs.writeFileSync(path.join(upDir, fn), PNG);
  db.prepare(`INSERT INTO photos (job_request_id, filename, original_name, mime, size_bytes, kind, vision_json)
    VALUES (?,?,?,?,?,'request','{}')`).run(jid, fn, 'bathroom.jpg', 'image/png', PNG.length);
}

// Estimates (REAL engine) for everything past 'new'.
for (const job of jobs) {
  if (job.status === 'new') continue;
  const scope = JSON.parse(job.scope_json);
  const photoCount = db.prepare('SELECT COUNT(*) c FROM photos WHERE job_request_id = ?').get(job.id).c;
  const r = estimateJob({ service_type: job.service_type, urgency: job.urgency, state: job.state, scope, photoCount });
  db.prepare(
    `INSERT INTO estimates (job_request_id, low_cents, high_cents, line_items_json, missing_json,
      risks_json, confidence, factors_json, engine_version, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(job.id, r.low_cents, r.high_cents, JSON.stringify(r.line_items), JSON.stringify(r.missing),
    JSON.stringify(r.risks), r.confidence, JSON.stringify(r.factors), r.engine_version, job.created_at);
  crm.touchInteraction(job.id, 'estimate_requested', 'seed');
}

// Quotes for quote_sent+ jobs. One quote sent 50h ago (follow-up rule demo).
const estOf = jid => db.prepare('SELECT * FROM estimates WHERE job_request_id = ? ORDER BY id DESC LIMIT 1').get(jid);
function makeQuote(job, priceC, costC, status, sentHoursAgo) {
  const e = estOf(job.id);
  const dep = Math.round(priceC * 0.3);
  const sent = sentHoursAgo != null
    ? new Date(Date.now() - sentHoursAgo * 3600000).toISOString().slice(0, 19).replace('T', ' ')
    : null;
  const info = db.prepare(
    `INSERT INTO quotes (job_request_id, estimate_id, customer_price_cents, contractor_cost_cents,
      deposit_cents, deposit_pct, status, valid_until, sent_at, created_at)
     VALUES (?,?,?,?,?,?,?, datetime('now','+14 days'), ?, ?)`
  ).run(job.id, e.id, priceC, costC, dep, 30, status, sent, job.created_at);
  return info.lastInsertRowid;
}
const q50h = makeQuote(jobs[5], 285000, 190000, 'sent', 50);   // stale -> follow-up task
makeQuote(jobs[6], 145000, 95000, 'sent', 20);
const qLost = makeQuote(jobs[10], 390000, 260000, 'rejected', 900);
db.prepare(`UPDATE quotes SET responded_at = datetime('now','-30 days') WHERE id = ?`).run(qLost);
for (const j of [jobs[0], jobs[1], jobs[2], jobs[3], jobs[4], jobs[11]]) {
  const e = estOf(j.id);
  const mid = Math.round((e.low_cents + e.high_cents) / 2);
  makeQuote(j, mid, Math.round(mid * 0.68), 'accepted', null);
  db.prepare(`UPDATE quotes SET responded_at = ? WHERE job_request_id = ? AND status = 'accepted'`)
    .run(j.created_at, j.id);
}

// Projects for accepted quotes.
const MILE = { painting: ['Prep and protection', 'Painting', 'Touch-up and final walkthrough'],
  plumbing: ['Diagnostic and parts', 'Repair / installation', 'Testing and cleanup'],
  bathroom: ['Demolition', 'Rough-in', 'Tile and fixtures', 'Finishes and cleanup'],
  electrical: ['Diagnostic and parts', 'Installation', 'Testing and cleanup'],
  flooring: ['Removal and prep', 'Installation', 'Transitions and cleanup'] };
const projOf = {};
for (const j of [jobs[0], jobs[1], jobs[2], jobs[3], jobs[4], jobs[11]]) {
  const q = db.prepare(`SELECT * FROM quotes WHERE job_request_id = ? AND status = 'accepted'`).get(j.id);
  const stage = { completed: 'completed', review: 'review', in_progress: 'in_progress' }[j.status] || 'completed';
  const info = db.prepare(
    `INSERT INTO projects (job_request_id, quote_id, customer_price_cents, contractor_cost_cents, stage, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(j.id, q.id, q.customer_price_cents, q.contractor_cost_cents, stage, j.created_at, j.created_at);
  const pid = info.lastInsertRowid;
  projOf[j.id] = pid;
  (MILE[j.service_type] || ['Preparation', 'Main work', 'Finishing and client review']).forEach((t, i) => {
    const done = stage === 'completed' || (stage === 'review' && i < 2) || (stage === 'in_progress' && i === 0);
    db.prepare(`INSERT INTO milestones (project_id, title, sort_order, status, customer_approval, approved_at)
      VALUES (?,?,?,?,?,?)`).run(pid, t, i, done ? 'completed' : (i === 1 && stage !== 'completed' ? 'in_progress' : 'pending'),
      done ? 'approved' : 'pending', done ? j.created_at : null);
  });
  db.prepare(`INSERT INTO payments (project_id, kind, amount_cents, status, provider, notes, created_at)
    VALUES (?, 'deposit', ?, 'recorded', 'manual', 'Seed deposit record', ?)`)
    .run(pid, q.deposit_cents, j.created_at);
}

// Assign active contractors to projects (sensible trade matching).
const sensible = { 0: 0, 1: 1, 2: 0, 3: 2, 4: 1, 11: 0 }; // jobIdx -> contractorIdx
for (const [ji, ci] of Object.entries(sensible)) {
  db.prepare('UPDATE projects SET contractor_id = ? WHERE id = ?').run(contractors[ci].id, projOf[jobs[ji].id]);
}

// Reviews for completed projects.
const revs = [[0, 5, 'Flawless bathroom remodel, crew was punctual and clean.'], [1, 5, 'Paint job looks amazing.'],
  [2, 4, 'Fixed fast, a bit pricey but worth it.'], [11, 5, 'Master bath is now my favorite room.']];
for (const [ji, rating, comment] of revs) {
  const pid = projOf[jobs[ji].id];
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(pid);
  const job = jobs[ji];
  db.prepare('INSERT INTO reviews (project_id, contractor_id, customer_id, rating, comment, created_at) VALUES (?,?,?,?,?,?)')
    .run(pid, p.contractor_id, job.customer_id, rating, comment, job.created_at);
}
for (const c of contractors) {
  const agg = db.prepare('SELECT AVG(rating) a FROM reviews WHERE contractor_id = ?').get(c.id);
  if (agg.a) db.prepare('UPDATE contractors SET rating_avg = ? WHERE id = ?').run(Math.round(agg.a * 10) / 10, c.id);
}

// Referrals.
db.prepare(`INSERT INTO referrals (code, referrer_user_id, status, discount_pct) VALUES ('HP-WELCOME1', ?, 'issued', 10)`)
  .run(customers[0].id);
db.prepare(`INSERT INTO referrals (code, referrer_user_id, referred_email, status, discount_pct, redeemed_at)
  VALUES ('HP-FRIEND20', ?, 'friend@example.com', 'redeemed', 10, datetime('now','-10 days'))`).run(customers[1].id);

// Email templates + campaigns.
const t1 = db.prepare(`INSERT INTO email_templates (name, subject, body_html) VALUES (?,?,?)`).run(
  'Inactive win-back', 'We miss you, {{name}} — 10% off your next project',
  '<p>Hi {{name}},</p><p>It has been a while since your last project with General Handyman Solutions. Here is 10% off your next booking — reply to this email and we will schedule it.</p><p>— The General Handyman Solutions team</p>'
).lastInsertRowid;
const t2 = db.prepare(`INSERT INTO email_templates (name, subject, body_html) VALUES (?,?,?)`).run(
  'Top contractor kudos', 'You are a top-rated pro, {{name}}!',
  '<p>Hi {{name}},</p><p>Your rating keeps you among our top contractors. New high-value jobs are coming your way first this month.</p><p>— The General Handyman Solutions team</p>'
).lastInsertRowid;
const camp1 = db.prepare(`INSERT INTO campaigns (name, segment, template_id, status) VALUES (?,?,?,'queued')`)
  .run('Q4 win-back: inactive 90d', 'inactive_clients_90d', t1).lastInsertRowid;
const camp2 = db.prepare(`INSERT INTO campaigns (name, segment, template_id, status) VALUES (?,?,?,'sending')`)
  .run('Top pro recognition', 'top_contractors', t2).lastInsertRowid;
// One already-sent outbox row + log, to prove the audit trail.
db.prepare(`INSERT INTO email_outbox (campaign_id, to_email, to_name, subject, body_html, status, provider, sent_at)
  VALUES (?,?,?,?,?,'sent','console', datetime('now','-2 days'))`)
  .run(camp2, 'carlos.m@example.com', 'Carlos Mendez', 'You are a top-rated pro, Carlos Mendez!',
    '<p>Hi Carlos Mendez,</p><p>Your rating keeps you among our top contractors.</p>');
const ob = db.prepare('SELECT id FROM email_outbox ORDER BY id DESC LIMIT 1').get().id;
db.prepare(`INSERT INTO email_log (outbox_id, to_email, subject, status, provider)
  VALUES (?, 'carlos.m@example.com', 'You are a top-rated pro, Carlos Mendez!', 'sent', 'console')`).run(ob);

// Make one past customer "inactive 100 days" so the win-back segment demo is real:
// Luis's completed job goes quiet (no activity in 100 days).
const luisJob = db.prepare(`SELECT id FROM job_requests WHERE email = 'luis.h@example.com' ORDER BY id LIMIT 1`).get();
if (luisJob) {
  db.prepare(`UPDATE job_requests SET updated_at = datetime(CURRENT_TIMESTAMP,'-100 days') WHERE id = ?`).run(luisJob.id);
}

// Follow-up tasks from the rules (the 50h-old quote should fire).
const tasks = crm.generateFollowupTasks();
console.log(`Seed complete. Follow-up tasks generated: ${tasks.length}`);
console.log('Demo logins -> admin: admin@generalhandymansolutions.test / Admin123! | customer: maya.t@example.com / Customer123! | contractor: carlos.m@example.com / Contractor123!');
