// General Handyman Solutions — critical-flow tests (node:test). Run: npm test
// Uses a throwaway SQLite DB and a server on :3457. No real email is sent:
// the mailer runs in console/log mode and every notification is recorded
// in email_log, which is exactly what the assertions check.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const TEST_DB = '/tmp/test-handyman.db';
const BASE = 'http://localhost:3457';

for (const f of [TEST_DB, TEST_DB + '-shm', TEST_DB + '-wal']) {
  try { fs.unlinkSync(f); } catch (e) { /* fresh */ }
}
process.env.DB_PATH = TEST_DB;
process.env.PORT = '3457';
process.env.JWT_SECRET = 'test-secret-for-automated-tests-only';
// The suite signs in far more than 20 times from one IP: raise the limiter (it stays ON, so its headers are still tested).
process.env.AUTH_RATE_LIMIT_MAX = '5000';
process.env.INTAKE_RATE_LIMIT_MAX = '5000';

const db = require('../src/db');

// When testing against PostgreSQL, start from a clean slate.
async function cleanPg() {
  if (!db._isPg) return;
  const tables = ['terms_acceptances','admin_audit','messages','message_threads','interactions',
    'followup_tasks','referrals','reviews','email_log','email_outbox','campaigns','email_templates',
    'payments','milestones','photos','projects','quotes','estimates','job_requests','contractors','users',
    'media_objects','stripe_events','contractor_payables','dispatch_assignments','ai_recommendations'];
  for (const t of tables) {
    try { await db.exec(`TRUNCATE "${t}" RESTART IDENTITY CASCADE`); } catch (e) { /* may not exist */ }
  }
}

require('../server'); // starts listening on :3457

async function api(method, p, body, token, form) {
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  let payload;
  if (form) { payload = form; }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + p, { method, headers, body: payload });
  let data = null;
  try { data = await res.json(); } catch (e) { /* empty */ }
  return { status: res.status, data, headers: res.headers };
}
const emailLogCount = async () => (await db.prepare('SELECT COUNT(*) c FROM email_log').get()).c;

let adminToken, custToken, contToken, adminId, custId, contUserId, contractorId, jobId, quoteId, projectId, csThread, scThread;

before(async () => {
  // wait for server
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 100));
  }
  await cleanPg();
  // Pre-insert admin so server.js does NOT auto-seed demo data.
  // (Upsert-safe: the suite may run against a reused database.)
  const existing = await db.prepare('SELECT id FROM users WHERE email = ?').get('admin@test.local');
  if (!existing) {
    await db.prepare(
      "INSERT INTO users (name, email, phone, password_hash, role, email_verified) VALUES (?,?,?,?,?,1)"
    ).run('Test Admin', 'admin@test.local', '555-000-0001', bcrypt.hashSync('Admin123!', 10), 'admin');
  }
  const a = await api('POST', '/api/auth/login', { email: 'admin@test.local', password: 'Admin123!' });
  assert.equal(a.status, 200);
  adminToken = a.data.token; adminId = a.data.user.id;
});

test('dual signup: customer + contractor, verification email queued', async () => {
  const c = await api('POST', '/api/auth/signup/customer',
    { name: 'Test Customer', email: 'cust@test.local', phone: '555-111-2222', password: 'Customer123!' });
  assert.equal(c.status, 201);
  assert.equal(c.data.verify_sent, true);
  assert.equal(c.data.user.email_verified, false);
  custToken = c.data.token; custId = c.data.user.id;

  const k = await api('POST', '/api/auth/signup/contractor',
    { name: 'Test Contractor', email: 'cont@test.local', phone: '555-333-4444', password: 'Contractor123!', legal_name: 'TC LLC', city: 'Fairfield' });
  assert.equal(k.status, 201);
  contToken = k.data.token; contUserId = k.data.user.id;

  // verification email was "sent" (logged)
  const row = await db.prepare("SELECT * FROM email_log WHERE to_email='cust@test.local' AND subject LIKE '%Verify%'").get();
  assert.ok(row, 'verification email logged');
});

test('email verification flow', async () => {
  const u = await db.prepare('SELECT verify_token FROM users WHERE email=?').get('cust@test.local');
  assert.ok(u.verify_token);
  const bad = await api('GET', '/api/auth/verify?token=nope');
  assert.equal(bad.status, 400);
  const ok = await api('GET', `/api/auth/verify?token=${u.verify_token}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.verified, true);
  const me = await api('GET', '/api/auth/me', undefined, custToken);
  assert.equal(me.data.email_verified, true);
});

test('password recovery flow (forgot/reset, expiring token)', async () => {
  const f = await api('POST', '/api/auth/forgot', { email: 'cust@test.local' });
  assert.equal(f.status, 200);
  const u = await db.prepare('SELECT reset_token, reset_expires FROM users WHERE email=?').get('cust@test.local');
  assert.ok(u.reset_token && u.reset_expires);

  // unknown email → same generic response (no user enumeration)
  const f2 = await api('POST', '/api/auth/forgot', { email: 'nobody@test.local' });
  assert.equal(f2.status, 200);
  assert.deepEqual(Object.keys(f2.data).sort(), Object.keys(f.data).sort());

  const weak = await api('POST', '/api/auth/reset', { token: u.reset_token, password: 'short' });
  assert.equal(weak.status, 422);
  const r = await api('POST', '/api/auth/reset', { token: u.reset_token, password: 'NewPass123!' });
  assert.equal(r.status, 200);
  const login = await api('POST', '/api/auth/login', { email: 'cust@test.local', password: 'NewPass123!' });
  assert.equal(login.status, 200);
  custToken = login.data.token;
  // token is single-use
  const reuse = await api('POST', '/api/auth/reset', { token: u.reset_token, password: 'Another123!' });
  assert.equal(reuse.status, 400);
});

test('job intake + photo upload (optimized) + estimate', async () => {
  const j = await api('POST', '/api/jobs', {
    name: 'Test Customer', phone: '555-111-2222', email: 'cust@test.local',
    address: '123 Main St, Fairfield CA', service_type: 'painting',
    description: 'Paint the living room, about 400 sqft, walls in decent shape.',
  }, custToken);
  assert.equal(j.status, 201);
  jobId = j.data.id;

  // build a real 2000px test photo with sharp
  const sharp = require('sharp');
  const buf = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: { r: 30, g: 120, b: 200 } } })
    .jpeg({ quality: 95 }).toBuffer();
  const form = new FormData();
  form.append('photos', new Blob([buf], { type: 'image/jpeg' }), 'room.jpg');
  const up = await api('POST', `/api/jobs/${jobId}/photos`, undefined, custToken, form);
  assert.equal(up.status, 201);
  assert.equal(up.data.optimized, true);
  const photo = await db.prepare('SELECT width, height, size_bytes FROM photos WHERE job_request_id=?').get(jobId);
  assert.ok(photo.width <= 1600 && photo.height <= 1600, `resized to ${photo.width}x${photo.height}`);
  assert.ok(photo.size_bytes < buf.length, 'compressed smaller than original');

  const e = await api('POST', `/api/jobs/${jobId}/estimate`, { scope: { sqft: 400 } }, custToken);
  assert.equal(e.status, 201);
  assert.ok(e.data.low_cents > 0 && e.data.high_cents >= e.data.low_cents);
});

test('quote create → send (customer notified) → accept requires terms (admin notified, project born)', async () => {
  const before = await emailLogCount();
  const q = await api('POST', '/api/quotes', {
    job_request_id: jobId, customer_price_cents: 120000, contractor_cost_cents: 80000, deposit_pct: 30,
  }, adminToken);
  assert.equal(q.status, 201);
  quoteId = q.data.id;

  const s = await api('POST', `/api/quotes/${quoteId}/send`, {}, adminToken);
  assert.equal(s.status, 200);
  assert.equal(s.data.status, 'sent');

  // customer got the "quote ready" email (logged)
  const n1 = await db.prepare("SELECT * FROM email_log WHERE to_email='cust@test.local' AND subject LIKE '%quote%ready%' ORDER BY id DESC").get();
  assert.ok(n1, 'quote-ready notification logged');

  // Legal gate: accepting without terms_accepted is rejected.
  const noTerms = await api('POST', `/api/quotes/${quoteId}/respond`, { accept: true }, custToken);
  assert.equal(noTerms.status, 400);
  assert.match(noTerms.data.error, /Terms of Service/);
  const stillSent = await db.prepare('SELECT status FROM quotes WHERE id=?').get(quoteId);
  assert.equal(stillSent.status, 'sent');

  const r = await api('POST', `/api/quotes/${quoteId}/respond`, { accept: true, terms_accepted: true }, custToken);
  assert.equal(r.status, 200);
  assert.equal(r.data.accepted, true);
  projectId = r.data.project_id;
  assert.ok(projectId);

  // Legal proof recorded: who accepted which terms version, when.
  const acc = await db.prepare(
    "SELECT * FROM terms_acceptances WHERE kind='client_quote' AND reference_id=? AND user_id=?"
  ).get(quoteId, custId);
  assert.ok(acc, 'client terms acceptance recorded');
  assert.ok(acc.terms_version, 'terms version recorded');
  assert.ok(acc.accepted_at, 'acceptance timestamp recorded');

  // admins got the "quote accepted" email
  const n2 = await db.prepare("SELECT * FROM email_log WHERE to_email='admin@test.local' AND subject LIKE '%accepted%' ORDER BY id DESC").get();
  assert.ok(n2, 'quote-accepted notification logged');

  assert.ok(await emailLogCount() > before, 'notifications were logged');
});

test('contractor offer → accept requires terms; decline releases the project', async () => {
  const c = await db.prepare('SELECT id FROM contractors WHERE user_id=?').get(contUserId);
  contractorId = c.id;
  const v = await api('PATCH', `/api/contractors/${contractorId}/verify`, {
    license_verified: true, insurance_verified: true, background_check: 'passed', status: 'active',
  }, adminToken);
  assert.equal(v.status, 200);
  assert.equal(v.data.status, 'active');

  // Admin offers (not force-assigns) the project.
  const a = await api('POST', `/api/projects/${projectId}/assign`, { contractor_id: contractorId }, adminToken);
  assert.equal(a.status, 200);
  assert.equal(a.data.contractor_id, contractorId);
  assert.equal(a.data.contractor_status, 'offered');

  const n1 = await db.prepare("SELECT * FROM email_log WHERE to_email='cont@test.local' AND subject LIKE '%offer%' ORDER BY id DESC").get();
  assert.ok(n1, 'contractor offer notification logged');

  // Contractor cannot move stages before accepting.
  const early = await api('PATCH', `/api/projects/${projectId}/stage`, { stage: 'in_progress' }, contToken);
  assert.equal(early.status, 403);

  // Accepting without terms is rejected.
  const noTerms = await api('POST', `/api/projects/${projectId}/contractor-respond`, { accept: true }, contToken);
  assert.equal(noTerms.status, 400);
  assert.match(noTerms.data.error, /Independent Contractor Terms/);

  // Accept with terms: project becomes scheduled, acceptance recorded.
  const ok = await api('POST', `/api/projects/${projectId}/contractor-respond`, { accept: true, terms_accepted: true }, contToken);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.accepted, true);
  assert.equal(ok.data.project.contractor_status, 'accepted');
  assert.equal(ok.data.project.stage, 'scheduled');
  const acc = await db.prepare(
    "SELECT * FROM terms_acceptances WHERE kind='contractor_job' AND reference_id=? AND user_id=?"
  ).get(projectId, contUserId);
  assert.ok(acc, 'contractor terms acceptance recorded');

  // Second project: decline path releases it back to the pool.
  const q2 = await api('POST', '/api/quotes', {
    job_request_id: jobId, customer_price_cents: 90000, contractor_cost_cents: 60000, deposit_pct: 30,
  }, adminToken);
  await api('POST', `/api/quotes/${q2.data.id}/send`, {}, adminToken);
  const r2 = await api('POST', `/api/quotes/${q2.data.id}/respond`, { accept: true, terms_accepted: true }, custToken);
  const p2 = r2.data.project_id;
  await api('POST', `/api/projects/${p2}/assign`, { contractor_id: contractorId }, adminToken);
  const d = await api('POST', `/api/projects/${p2}/contractor-respond`, { accept: false }, contToken);
  assert.equal(d.status, 200);
  assert.equal(d.data.accepted, false);
  const released = await db.prepare('SELECT contractor_id, contractor_status FROM projects WHERE id=?').get(p2);
  assert.equal(released.contractor_id, null);
  assert.equal(released.contractor_status, null);
});

test('MEDIATED messaging: no direct client<->contractor contact possible', async () => {
  // customer creates their thread — kind forced to client_support even if they ask otherwise
  const t1 = await api('POST', `/api/projects/${projectId}/threads`, { kind: 'support_contractor' }, custToken);
  assert.equal(t1.status, 201);
  assert.equal(t1.data.kind, 'client_support', 'customer cannot obtain a contractor thread');
  csThread = t1.data.id;

  const m1 = await api('POST', `/api/threads/${csThread}/messages`, { body: 'Hi, when will the work start?' }, custToken);
  assert.equal(m1.status, 201);
  assert.equal(m1.data.sender_role, 'customer');

  // contractor creates their thread
  const t2 = await api('POST', `/api/projects/${projectId}/threads`, {}, contToken);
  assert.equal(t2.status, 201);
  assert.equal(t2.data.kind, 'support_contractor');
  scThread = t2.data.id;

  const m2 = await api('POST', `/api/threads/${scThread}/messages`, { body: 'Materials ordered, starting Monday.' }, contToken);
  assert.equal(m2.status, 201);

  // CROSS-ACCESS IS FORBIDDEN:
  const x1 = await api('GET', `/api/threads/${scThread}/messages`, undefined, custToken);
  assert.equal(x1.status, 403, 'customer must NOT read the contractor thread');
  const x2 = await api('GET', `/api/threads/${csThread}/messages`, undefined, contToken);
  assert.equal(x2.status, 403, 'contractor must NOT read the customer thread');
  const x3 = await api('POST', `/api/threads/${scThread}/messages`, { body: 'sneaky' }, custToken);
  assert.equal(x3.status, 403, 'customer must NOT write to the contractor thread');

  // admin sees both (support sits in the middle)
  const a1 = await api('GET', `/api/threads/${csThread}/messages`, undefined, adminToken);
  assert.equal(a1.status, 200);
  assert.equal(a1.data.length, 1);
  const a2 = await api('GET', `/api/threads/${scThread}/messages`, undefined, adminToken);
  assert.equal(a2.status, 200);

  // admin replies in the customer thread → customer gets an email
  const m3 = await api('POST', `/api/threads/${csThread}/messages`, { body: 'We start Monday at 9am.' }, adminToken);
  assert.equal(m3.status, 201);
  const n = await db.prepare("SELECT * FROM email_log WHERE to_email='cust@test.local' AND subject LIKE '%New message%' ORDER BY id DESC").get();
  assert.ok(n, 'message notification email logged');

  // empty message rejected
  const e1 = await api('POST', `/api/threads/${csThread}/messages`, { body: '   ' }, custToken);
  assert.equal(e1.status, 422);
});

test('milestone complete → customer notified; approve → contractor notified', async () => {
  const p = await api('GET', `/api/projects/${projectId}`, undefined, adminToken);
  const mid = p.data.milestones[0].id;

  const c1 = await api('POST', `/api/projects/${projectId}/milestones/${mid}/complete`, {}, contToken);
  assert.equal(c1.status, 200);
  const n1 = await db.prepare("SELECT * FROM email_log WHERE to_email='cust@test.local' AND subject LIKE '%Milestone done%' ORDER BY id DESC").get();
  assert.ok(n1, 'milestone-done notification logged');

  const a1 = await api('POST', `/api/projects/${projectId}/milestones/${mid}/approve`, { approved: true }, custToken);
  assert.equal(a1.status, 200);
  const n2 = await db.prepare("SELECT * FROM email_log WHERE to_email='cont@test.local' AND subject LIKE '%Milestone approved%' ORDER BY id DESC").get();
  assert.ok(n2, 'milestone-approved notification logged');
});

test('project scheduling with date validation', async () => {
  const bad = await api('PATCH', `/api/projects/${projectId}/schedule`,
    { scheduled_start: '2026-11-10', scheduled_end: '2026-11-05' }, adminToken);
  assert.equal(bad.status, 422);
  const bad2 = await api('PATCH', `/api/projects/${projectId}/schedule`,
    { scheduled_start: 'not-a-date' }, adminToken);
  assert.equal(bad2.status, 422);
  const ok = await api('PATCH', `/api/projects/${projectId}/schedule`,
    { scheduled_start: '2026-11-05', scheduled_end: '2026-11-10' }, adminToken);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.scheduled_start, '2026-11-05');
  assert.equal(ok.data.scheduled_end, '2026-11-10');
  // contractor cannot schedule
  const f = await api('PATCH', `/api/projects/${projectId}/schedule`, { scheduled_start: '2026-12-01' }, contToken);
  assert.equal(f.status, 403);
});

test('admin audit trail records everything', async () => {
  const rows = await api('GET', '/api/crm/audit?limit=50', undefined, adminToken);
  assert.equal(rows.status, 200);
  const actions = rows.data.map(r => r.action);
  for (const a of ['quote.created', 'quote.sent', 'project.contractor_offered', 'project.contractor_accepted', 'milestone.completed', 'milestone.approved', 'project.scheduled', 'contractor.verified']) {
    assert.ok(actions.includes(a), `audit has ${a}`);
  }
  // Admin-initiated actions are attributed to the admin; actor actions (contractor
  // completing a milestone, customer approving) are attributed to their actor.
  const byAction = Object.fromEntries(rows.data.map(r => [r.action, r.admin_name]));
  assert.equal(byAction['quote.created'], 'Test Admin');
  assert.equal(byAction['quote.sent'], 'Test Admin');
  assert.equal(byAction['milestone.completed'], 'Test Contractor');
  assert.equal(byAction['milestone.approved'], 'Test Customer');
  // non-admin cannot read audit
  const f = await api('GET', '/api/crm/audit', undefined, custToken);
  assert.equal(f.status, 403);
});

test('stripe disabled: status off, deposit-intent refused, manual deposit recorded', async () => {
  const s = await api('GET', '/api/payments/stripe-status');
  assert.equal(s.status, 200);
  assert.equal(s.data.implemented, true);
  assert.equal(s.data.enabled, false);
  assert.equal(s.data.publishable_key, null);

  const d = await api('POST', '/api/payments/deposit-intent', { project_id: projectId }, custToken);
  assert.equal(d.status, 503);

  // Without Stripe keys the accept flow keeps the manual bookkeeping path.
  const pay = await db.prepare("SELECT * FROM payments WHERE project_id=? AND kind='deposit'").get(projectId);
  assert.ok(pay, 'manual deposit record exists');
  assert.equal(pay.provider, 'manual');
  assert.equal(pay.status, 'recorded');
});

test('rate limiting headers present on auth endpoints', async () => {
  const r = await api('POST', '/api/auth/login', { email: 'admin@test.local', password: 'wrong' });
  assert.equal(r.status, 401);
  const rl = r.headers.get('ratelimit'); // draft-7 combined header
  assert.ok(rl && rl.includes(`limit=${process.env.AUTH_RATE_LIMIT_MAX}`), 'rate-limit headers present');
});

test('project completion notifies customer', async () => {
  // Gate: every milestone must be approved by the customer before completion.
  const pd = await api('GET', `/api/projects/${projectId}`, undefined, adminToken);
  for (const m of pd.data.milestones.filter(x => x.customer_approval !== 'approved')) {
    await api('POST', `/api/projects/${projectId}/milestones/${m.id}/complete`, {}, contToken);
    const ap = await api('POST', `/api/projects/${projectId}/milestones/${m.id}/approve`, { approved: true }, custToken);
    assert.equal(ap.status, 200);
  }
  const s = await api('PATCH', `/api/projects/${projectId}/stage`, { stage: 'completed' }, adminToken);
  assert.equal(s.status, 200);
  const n = await db.prepare("SELECT * FROM email_log WHERE to_email='cust@test.local' AND subject LIKE '%complete%' ORDER BY id DESC").get();
  assert.ok(n, 'project-completed notification logged');
});

test('contractor recommendations: admin gets ranked matches, others refused', async () => {
  // Make the test contractor fully verified + active so matching can rank them.
  await db.prepare(`UPDATE contractors SET status='active', license_verified=1, insurance_verified=1, background_check='passed', specialties='["painting"]', rating_avg=4.5 WHERE id=?`).run(contractorId);
  const r = await api('GET', `/api/projects/${projectId}/recommendations`, undefined, adminToken);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data.recommendations), 'recommendations is an array');
  assert.equal(r.data.meta.eligible, 1);
  const top = r.data.recommendations[0];
  assert.equal(top.contractor_id, contractorId);
  assert.ok(top.score > 0 && top.score <= 100, 'score in range: ' + top.score);
  assert.ok(top.parts && typeof top.parts.specialty === 'number', 'score parts present');

  const c = await api('GET', `/api/projects/${projectId}/recommendations`, undefined, contToken);
  assert.equal(c.status, 403);
  const anon = await api('GET', `/api/projects/${projectId}/recommendations`);
  assert.equal(anon.status, 401);
});

// ===================== REGRESSION TESTS (audit hardening) =====================
// Helper: create + send + accept a fresh quote -> returns { quoteId, projectId }.
async function freshProject(price = 50000, cost = 30000) {
  const q = await api('POST', '/api/quotes', { job_request_id: jobId, customer_price_cents: price, contractor_cost_cents: cost, deposit_pct: 30 }, adminToken);
  await api('POST', `/api/quotes/${q.data.id}/send`, {}, adminToken);
  const r = await api('POST', `/api/quotes/${q.data.id}/respond`, { accept: true, terms_accepted: true }, custToken);
  return { quoteId: q.data.id, projectId: r.data.project_id, status: r.status };
}

test('REGRESSION: project API never leaks margin or contractor email (role-aware)', async () => {
  const list = await api('GET', '/api/projects', undefined, custToken);
  assert.equal(list.status, 200);
  assert.ok(list.data.length > 0, 'project list is not empty');
  assert.ok(list.data.every(p => p.id), 'list items are real objects, not {}');
  const detail = await api('GET', `/api/projects/${projectId}`, undefined, custToken);
  assert.equal(detail.data.contractor_cost_cents, undefined, 'customer must not see contractor cost');
  assert.ok(!JSON.stringify(detail.data).includes('cont@test.local'), 'customer must not see contractor email');
  const asContractor = await api('GET', `/api/projects/${projectId}`, undefined, contToken);
  assert.equal(asContractor.data.customer_price_cents, undefined, 'contractor must not see customer price');
  assert.equal(asContractor.data.payments, undefined, 'contractor must not see payments');
  assert.ok(asContractor.data.contractor_cost_cents > 0, 'contractor still sees their own budget');
  const asAdmin = await api('GET', `/api/projects/${projectId}`, undefined, adminToken);
  assert.ok(asAdmin.data.customer_price_cents > 0 && asAdmin.data.contractor_cost_cents > 0, 'admin sees both');
  const pays = await api('GET', '/api/payments', undefined, contToken);
  assert.deepEqual(pays.data, [], 'contractor sees no payments');
});

test('REGRESSION: admin KPI overview returns real numbers', async () => {
  const r = await api('GET', '/api/reports/overview', undefined, adminToken);
  assert.equal(r.status, 200);
  for (const k of ['jobs', 'quotes_sent', 'quotes_accepted', 'projects_completed', 'revenue_cents', 'cost_cents', 'avg_ticket_cents']) {
    assert.equal(typeof r.data[k], 'number', `${k} is a number`);
  }
  assert.ok(r.data.jobs >= 1, 'jobs counted');
  assert.ok(r.data.revenue_cents > 0, 'revenue counted from completed projects');
});

test('REGRESSION: accepting the same quote twice at once creates ONE project', async () => {
  const q = await api('POST', '/api/quotes', { job_request_id: jobId, customer_price_cents: 70000, contractor_cost_cents: 40000, deposit_pct: 30 }, adminToken);
  await api('POST', `/api/quotes/${q.data.id}/send`, {}, adminToken);
  const body = { accept: true, terms_accepted: true };
  const [a, b] = await Promise.all([
    api('POST', `/api/quotes/${q.data.id}/respond`, body, custToken),
    api('POST', `/api/quotes/${q.data.id}/respond`, body, custToken),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 400]);
  const n = (await db.prepare('SELECT COUNT(*) c FROM projects WHERE quote_id = ?').get(q.data.id)).c;
  assert.equal(Number(n), 1, 'exactly one project for the quote');
});

test('REGRESSION: guest request can be claimed by an account with its claim token', async () => {
  const g = await api('POST', '/api/jobs', {
    name: 'Guest Person', phone: '555-777-8888', email: 'guest@test.local',
    address: '1 Main St', service_type: 'painting', description: 'Paint one bedroom, walls and ceiling please.',
  });
  assert.equal(g.status, 201);
  const gid = g.data.id, token = g.data.claim_token;
  const bad = await api('POST', `/api/jobs/${gid}/claim`, { claim_token: 'x'.repeat(32) }, custToken);
  assert.equal(bad.status, 403);
  const anon = await api('POST', `/api/jobs/${gid}/claim`, { claim_token: token });
  assert.equal(anon.status, 401);
  const ok = await api('POST', `/api/jobs/${gid}/claim`, { claim_token: token }, custToken);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.customer_id, custId);
  const mine = await api('GET', `/api/jobs/${gid}`, undefined, custToken);
  assert.equal(mine.status, 200, 'owner can now read the request with their account');
  // a different customer cannot take it over
  const other = await api('POST', '/api/auth/signup/customer', { name: 'Other Cust', email: 'other@test.local', phone: '555-222-3333', password: 'Customer123!' });
  const steal = await api('POST', `/api/jobs/${gid}/claim`, { claim_token: token }, other.data.token);
  assert.equal(steal.status, 409);
});

test('REGRESSION: unverified email cannot accept a quote', async () => {
  const k = await api('POST', '/api/auth/signup/customer', { name: 'Unverified', email: 'unv@test.local', phone: '555-444-5555', password: 'Customer123!' });
  assert.equal(k.status, 201);
  const job = await api('POST', '/api/jobs', {
    name: 'Unverified', phone: '555-444-5555', email: 'unv@test.local', address: '2 Main St',
    service_type: 'painting', description: 'Paint the living room walls, two coats.',
  }, k.data.token);
  const q = await api('POST', '/api/quotes', { job_request_id: job.data.id, customer_price_cents: 40000, contractor_cost_cents: 25000, deposit_pct: 30 }, adminToken);
  await api('POST', `/api/quotes/${q.data.id}/send`, {}, adminToken);
  const r = await api('POST', `/api/quotes/${q.data.id}/respond`, { accept: true, terms_accepted: true }, k.data.token);
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'EMAIL_NOT_VERIFIED');
});

test('REGRESSION: contractor cannot be offered a job before the deposit is in', async () => {
  const fp = await freshProject();
  assert.ok(fp.projectId, 'project created');
  const job = await db.prepare('SELECT job_request_id FROM projects WHERE id = ?').get(fp.projectId);
  await db.prepare("UPDATE job_requests SET status = 'quote_sent' WHERE id = ?").run(job.job_request_id);
  const blocked = await api('POST', `/api/projects/${fp.projectId}/assign`, { contractor_id: contractorId }, adminToken);
  assert.equal(blocked.status, 409);
  // recording the deposit manually moves the pipeline forward and unblocks assignment
  const rec = await api('POST', '/api/payments', { project_id: fp.projectId, kind: 'deposit', amount_cents: 15000 }, adminToken);
  assert.equal(rec.status, 201);
  const ok = await api('POST', `/api/projects/${fp.projectId}/assign`, { contractor_id: contractorId }, adminToken);
  assert.equal(ok.status, 200);
});

test('REGRESSION: project cannot complete without approved milestones (admin force is audited)', async () => {
  const fp = await freshProject();
  const blocked = await api('PATCH', `/api/projects/${fp.projectId}/stage`, { stage: 'completed' }, adminToken);
  assert.equal(blocked.status, 409);
  const forced = await api('PATCH', `/api/projects/${fp.projectId}/stage`, { stage: 'completed', force: true }, adminToken);
  assert.equal(forced.status, 200);
  const audit = await db.prepare("SELECT id FROM admin_audit WHERE action = 'project.force_completed' AND entity_id = ?").get(fp.projectId);
  assert.ok(audit, 'forced completion is in the audit trail');
});

test('REGRESSION: messages that exchange contact details are flagged for support only', async () => {
  const m = await api('POST', `/api/threads/${csThread}/messages`, { body: 'Call me at 707-555-0123 or mail me@example.com' }, custToken);
  assert.equal(m.status, 201);
  const asAdmin = await api('GET', `/api/threads/${csThread}/messages`, undefined, adminToken);
  const flagged = asAdmin.data.find(x => x.id === m.data.id);
  assert.equal(flagged.flagged, 1);
  const asCust = await api('GET', `/api/threads/${csThread}/messages`, undefined, custToken);
  const seen = asCust.data.find(x => x.id === m.data.id);
  assert.equal(seen.flagged, undefined, 'customer does not see the flag');
});

test('REGRESSION: password reset revokes tokens issued before it', async () => {
  const k = await api('POST', '/api/auth/signup/customer', { name: 'Reset Me', email: 'reset@test.local', phone: '555-666-7777', password: 'Customer123!' });
  const oldToken = k.data.token;
  assert.equal((await api('GET', '/api/auth/me', undefined, oldToken)).status, 200);
  await api('POST', '/api/auth/forgot', { email: 'reset@test.local' });
  const u = await db.prepare('SELECT reset_token FROM users WHERE email = ?').get('reset@test.local');
  const rs = await api('POST', '/api/auth/reset', { token: u.reset_token, password: 'NewPassword123!' });
  assert.equal(rs.status, 200);
  assert.equal((await api('GET', '/api/auth/me', undefined, oldToken)).status, 401, 'old session is revoked');
  const login = await api('POST', '/api/auth/login', { email: 'reset@test.local', password: 'NewPassword123!' });
  assert.equal(login.status, 200);
  assert.equal((await api('GET', '/api/auth/me', undefined, login.data.token)).status, 200);
});

test('REGRESSION: unauthorized photo upload writes nothing to disk', async () => {
  const dir = path.join(__dirname, '..', 'uploads');
  const count = () => (fs.existsSync(dir) ? fs.readdirSync(dir).length : 0);
  const before = count();
  const form = new FormData();
  form.append('photos', new Blob([Buffer.from('fake image bytes')], { type: 'image/jpeg' }), 'x.jpg');
  const res = await fetch(`${BASE}/api/jobs/${jobId}/photos`, { method: 'POST', body: form }); // no token, no claim
  assert.equal(res.status, 403);
  assert.equal(count(), before, 'no file was written for an unauthorized caller');
});

test('REGRESSION: unsubscribe links are signed; opt-outs are honored', async () => {
  const unsub = require('../src/services/unsubscribe');
  const link = unsub.link('Optout@Test.local').replace(/^https?:\/\/[^/]+/, '');
  const page = await fetch(BASE + link);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Yes, unsubscribe me/);
  const forged = await fetch(BASE + link.replace(/t=[a-f0-9]+/, 't=' + '0'.repeat(64)), { method: 'POST' });
  assert.equal(forged.status, 400);
  const done = await fetch(BASE + link, { method: 'POST' });
  assert.equal(done.status, 200);
  assert.equal(await unsub.isSuppressed('optout@test.local'), true);
  const crm = require('../src/services/crm');
  assert.ok(Array.isArray(await crm.segmentMembers('all_customers')), 'segments resolve to an array');
});

test('REGRESSION: health check touches the database; stripe webhook refuses when off', async () => {
  const h = await api('GET', '/api/health');
  assert.equal(h.status, 200);
  assert.equal(h.data.ok, true);
  const w = await api('POST', '/api/payments/webhook', { x: 1 });
  assert.equal(w.status, 503);
  const fi = await api('POST', '/api/payments/final-intent', { project_id: projectId }, custToken);
  assert.equal(fi.status, 503, 'final-intent refuses when Stripe is not configured');
});

test('REGRESSION: customer can export their data (no margin, no secrets)', async () => {
  const r = await api('GET', '/api/me/export', undefined, custToken);
  assert.equal(r.status, 200);
  assert.equal(r.data.profile.email, 'cust@test.local');
  assert.ok(r.data.requests.length >= 1 && r.data.projects.length >= 1);
  const raw = JSON.stringify(r.data);
  assert.ok(!raw.includes('contractor_cost_cents'), 'export never includes the contractor cost');
  assert.ok(!raw.includes('password'), 'export never includes credentials');
  const anon = await api('GET', '/api/me/export');
  assert.equal(anon.status, 401);
});

test('REGRESSION: account deletion anonymizes, needs the password, and is blocked mid-project', async () => {
  // blocked: custToken has an active project
  const blocked = await api('POST', '/api/me/delete', { password: 'NewPass123!' }, custToken); // the password set in the recovery test
  assert.equal(blocked.status, 409);
  // fresh customer with a request but no project
  const k = await api('POST', '/api/auth/signup/customer', { name: 'Delete Me', email: 'todelete@test.local', phone: '555-101-2020', password: 'Customer123!' });
  assert.equal(k.status, 201);
  const job = await api('POST', '/api/jobs', {
    name: 'Delete Me', phone: '555-101-2020', email: 'todelete@test.local', address: '9 Secret Ln',
    service_type: 'painting', description: 'Paint the hallway, please include trim and doors.',
  }, k.data.token);
  assert.equal(job.status, 201);
  const wrong = await api('POST', '/api/me/delete', { password: 'nope' }, k.data.token);
  assert.equal(wrong.status, 403);
  const ok = await api('POST', '/api/me/delete', { password: 'Customer123!' }, k.data.token);
  assert.equal(ok.status, 200);
  const u = await db.prepare('SELECT name, email, phone FROM users WHERE id = ?').get(k.data.user.id);
  assert.equal(u.name, 'Deleted user');
  assert.match(u.email, /^deleted-\d+@deleted\.invalid$/);
  const j = await db.prepare('SELECT name, address, email FROM job_requests WHERE id = ?').get(job.data.id);
  assert.equal(j.address, '[removed]');
  assert.equal(j.email, null);
  assert.equal((await api('GET', '/api/auth/me', undefined, k.data.token)).status, 401, 'old session is dead');
  assert.equal((await api('POST', '/api/auth/login', { email: 'todelete@test.local', password: 'Customer123!' })).status, 401);
  const unsub = require('../src/services/unsubscribe');
  assert.equal(await unsub.isSuppressed('todelete@test.local'), true, 'no more marketing to that address');
});

test('REGRESSION: email-provider events put bounces and complaints on the suppression list', async () => {
  const unsub = require('../src/services/unsubscribe');
  delete process.env.SENDGRID_WEBHOOK_KEY;
  assert.equal((await api('POST', '/api/email/events?key=x', [])).status, 503);
  process.env.SENDGRID_WEBHOOK_KEY = 'test-webhook-key-123';
  assert.equal((await api('POST', '/api/email/events?key=wrong', [])).status, 401);
  const ok = await api('POST', '/api/email/events?key=test-webhook-key-123', [
    { email: 'Bounced@Test.local', event: 'bounce' },
    { email: 'fine@test.local', event: 'delivered' },
    { email: 'angry@test.local', event: 'spamreport' },
  ]);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.suppressed, 2);
  assert.equal(await unsub.isSuppressed('bounced@test.local'), true);
  assert.equal(await unsub.isSuppressed('fine@test.local'), false);
  delete process.env.SENDGRID_WEBHOOK_KEY;
});

test('REGRESSION: admin can set a contractor location (validated); others cannot', async () => {
  const bad = await api('PATCH', `/api/contractors/${contractorId}/location`, { lat: 999, lng: 5 }, adminToken);
  assert.equal(bad.status, 422);
  const ok = await api('PATCH', `/api/contractors/${contractorId}/location`, { lat: 38.2494, lng: -122.04 }, adminToken);
  assert.equal(ok.status, 200);
  const row = await db.prepare('SELECT lat, lng FROM contractors WHERE id = ?').get(contractorId);
  assert.equal(Math.round(row.lat * 1000), 38249);
  assert.equal((await api('PATCH', `/api/contractors/${contractorId}/location`, { lat: 1, lng: 1 }, contToken)).status, 403);
});

test('REGRESSION: agenda lists active projects and warns on contractor double-booking', async () => {
  const a = await freshProject();
  const b = await freshProject();
  for (const p of [a, b]) {
    assert.equal((await api('POST', `/api/projects/${p.projectId}/assign`, { contractor_id: contractorId }, adminToken)).status, 200);
  }
  const s1 = await api('PATCH', `/api/projects/${a.projectId}/schedule`, { scheduled_start: '2027-03-01', scheduled_end: '2027-03-03' }, adminToken);
  assert.equal(s1.status, 200);
  assert.deepEqual(s1.data.conflicts, []);
  const s2 = await api('PATCH', `/api/projects/${b.projectId}/schedule`, { scheduled_start: '2027-03-03', scheduled_end: '2027-03-04' }, adminToken);
  assert.equal(s2.status, 200, 'overlap warns but never blocks');
  assert.deepEqual(s2.data.conflicts, [a.projectId]);

  const ag = await api('GET', '/api/projects/schedule?from=2027-03-01&to=2027-03-07', undefined, adminToken);
  assert.equal(ag.status, 200);
  const ids = ag.data.items.map(i => i.id);
  assert.ok(ids.includes(a.projectId) && ids.includes(b.projectId));
  assert.ok(ag.data.items.filter(i => [a.projectId, b.projectId].includes(i.id)).every(i => i.conflicts.length === 1));
  assert.ok(ag.data.conflict_count >= 2);
  assert.ok(Array.isArray(ag.data.unscheduled));
  // outside the window they do not appear
  const other = await api('GET', '/api/projects/schedule?from=2027-04-01&to=2027-04-07', undefined, adminToken);
  assert.ok(!other.data.items.some(i => i.id === a.projectId));
  // permissions and validation
  assert.equal((await api('GET', '/api/projects/schedule', undefined, custToken)).status, 403);
  assert.equal((await api('GET', '/api/projects/schedule', undefined, contToken)).status, 403);
  assert.equal((await api('GET', '/api/projects/schedule?from=2027-03-05&to=2027-03-01', undefined, adminToken)).status, 422);
});

test('REGRESSION: completion sheet needs approved milestones, is signed once by the customer, and is visible by role', async () => {
  const fp = await freshProject();
  const pid = fp.projectId;
  assert.equal((await api('POST', `/api/projects/${pid}/assign`, { contractor_id: contractorId }, adminToken)).status, 200);
  assert.equal((await api('POST', `/api/projects/${pid}/contractor-respond`, { accept: true, terms_accepted: true }, contToken)).status, 200);
  assert.equal((await api('PATCH', `/api/projects/${pid}/stage`, { stage: 'in_progress' }, contToken)).status, 200);

  const sig = 'data:image/png;base64,' + 'A'.repeat(1200);
  const body = { signer_name: 'Test Customer', signature: sig, checklist: { work_complete: true, site_clean: true } };

  // 1) not before every milestone is approved
  assert.equal((await api('POST', `/api/projects/${pid}/sign-off`, body, custToken)).status, 409);
  const detail = await api('GET', `/api/projects/${pid}`, undefined, adminToken);
  for (const m of detail.data.milestones) {
    await api('POST', `/api/projects/${pid}/milestones/${m.id}/complete`, {}, contToken);
    assert.equal((await api('POST', `/api/projects/${pid}/milestones/${m.id}/approve`, { approved: true }, custToken)).status, 200);
  }
  // 2) only the customer signs
  assert.equal((await api('POST', `/api/projects/${pid}/sign-off`, body, contToken)).status, 403);
  assert.equal((await api('POST', `/api/projects/${pid}/sign-off`, body, adminToken)).status, 403);
  // 3) validation: signature, name, checklist
  assert.equal((await api('POST', `/api/projects/${pid}/sign-off`, { ...body, signature: 'data:image/png;base64,AAAA' }, custToken)).status, 422);
  assert.equal((await api('POST', `/api/projects/${pid}/sign-off`, { ...body, signature: '<script>alert(1)</script>' }, custToken)).status, 422);
  assert.equal((await api('POST', `/api/projects/${pid}/sign-off`, { ...body, signer_name: '' }, custToken)).status, 422);
  assert.equal((await api('POST', `/api/projects/${pid}/sign-off`, { ...body, checklist: { work_complete: true } }, custToken)).status, 422);
  // 4) signs, exactly once
  const ok = await api('POST', `/api/projects/${pid}/sign-off`, body, custToken);
  assert.equal(ok.status, 201);
  assert.equal(ok.data.signed, true);
  assert.equal((await api('POST', `/api/projects/${pid}/sign-off`, body, custToken)).status, 409);
  // 5) who sees what
  const asCust = await api('GET', `/api/projects/${pid}/sign-off`, undefined, custToken);
  assert.equal(asCust.data.signer_name, 'Test Customer');
  assert.equal(asCust.data.ip, undefined, 'customer does not get the IP');
  const asAdmin = await api('GET', `/api/projects/${pid}/sign-off`, undefined, adminToken);
  assert.ok(asAdmin.data.signature_png && 'ip' in asAdmin.data, 'admin sees the full record');
  const asCont = await api('GET', `/api/projects/${pid}/sign-off`, undefined, contToken);
  assert.equal(asCont.data.signed, true);
  assert.equal(asCont.data.signature_png, undefined, 'contractor never gets the signature');
  const proj = await api('GET', `/api/projects/${pid}`, undefined, custToken);
  assert.ok(proj.data.completion_signed_at, 'project payload shows the signed date');
  const audit = await db.prepare("SELECT id FROM admin_audit WHERE action = 'project.signed_off' AND entity_id = ?").get(pid);
  assert.ok(audit, 'sign-off is in the audit trail');
});

test('REGRESSION: contractor payouts are created on completion, guarded by the customer balance, paid once, and role-scoped', async () => {
  const complete = async (pid) => api('PATCH', `/api/projects/${pid}/stage`, { stage: 'completed', force: true }, adminToken);
  const rowFor = async (pid) => (await api('GET', '/api/payables', undefined, adminToken)).data.payables.find(r => r.project_id === pid);

  // Project A: the customer still owes money
  const A = await freshProject();
  assert.equal((await api('POST', `/api/projects/${A.projectId}/assign`, { contractor_id: contractorId }, adminToken)).status, 200);
  assert.equal((await complete(A.projectId)).status, 200);
  const a = await rowFor(A.projectId);
  assert.equal(a.payable_cents, 30000);
  assert.equal(a.status, 'pending');
  assert.equal(a.customer_balance_cents, 35000);
  const before = (await db.prepare('SELECT jobs_completed AS n FROM contractors WHERE id = ?').get(contractorId)).n;
  assert.equal((await complete(A.projectId)).status, 200, 'completing again is harmless');
  assert.equal((await db.prepare('SELECT jobs_completed AS n FROM contractors WHERE id = ?').get(contractorId)).n, before, 'the job is not counted twice');
  assert.equal((await api('GET', '/api/payables', undefined, adminToken)).data.payables.filter(r => r.project_id === A.projectId).length, 1);

  // roles
  assert.equal((await api('GET', '/api/payables', undefined, contToken)).status, 403);
  assert.equal((await api('GET', '/api/payables', undefined, custToken)).status, 403);
  assert.equal((await api('GET', '/api/payables/mine', undefined, custToken)).status, 403);
  const mine = await api('GET', '/api/payables/mine', undefined, contToken);
  assert.ok(mine.data.payables.some(r => r.project_id === A.projectId));
  assert.ok(mine.data.totals.pending_cents >= 30000);

  // guarded payment
  assert.equal((await api('POST', `/api/payables/${a.id}/pay`, {}, adminToken)).status, 422, 'method required');
  const blocked = await api('POST', `/api/payables/${a.id}/pay`, { method: 'ach' }, adminToken);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.customer_balance_cents, 35000);
  assert.equal((await api('POST', `/api/payables/${a.id}/approve`, {}, adminToken)).status, 200);
  assert.equal((await api('POST', `/api/payables/${a.id}/approve`, {}, adminToken)).status, 409);
  const forced = await api('POST', `/api/payables/${a.id}/pay`, { method: 'check', reference: '#1042', force: true }, adminToken);
  assert.equal(forced.status, 200);
  assert.equal(forced.data.status, 'paid');
  assert.equal(forced.data.paid_method, 'check');
  assert.equal((await api('POST', `/api/payables/${a.id}/pay`, { method: 'ach', force: true }, adminToken)).status, 409, 'cannot be paid twice');
  assert.ok(await db.prepare("SELECT id FROM admin_audit WHERE action = 'payable.paid_forced' AND entity_id = ?").get(a.id));

  // Project B: customer settled in full -> no override needed
  const B = await freshProject();
  await api('POST', `/api/projects/${B.projectId}/assign`, { contractor_id: contractorId }, adminToken);
  assert.equal((await api('POST', '/api/payments', { project_id: B.projectId, kind: 'final', amount_cents: 35000 }, adminToken)).status, 201);
  await complete(B.projectId);
  const b = await rowFor(B.projectId);
  assert.equal(b.customer_balance_cents, 0);
  assert.equal((await api('POST', `/api/payables/${b.id}/pay`, { method: 'zelle' }, adminToken)).status, 200);
  assert.ok(await db.prepare("SELECT id FROM admin_audit WHERE action = 'payable.paid' AND entity_id = ?").get(b.id));

  // Project C: cancel needs a reason; a cancelled payable cannot be paid
  const C = await freshProject();
  await api('POST', `/api/projects/${C.projectId}/assign`, { contractor_id: contractorId }, adminToken);
  await complete(C.projectId);
  const c = await rowFor(C.projectId);
  assert.equal((await api('POST', `/api/payables/${c.id}/cancel`, {}, adminToken)).status, 422);
  assert.equal((await api('POST', `/api/payables/${c.id}/cancel`, { notes: 'Work redone by another contractor' }, adminToken)).status, 200);
  assert.equal((await api('POST', `/api/payables/${c.id}/pay`, { method: 'ach', force: true }, adminToken)).status, 409);

  // yearly totals + CSV
  const year = new Date().getUTCFullYear();
  const sum = await api('GET', `/api/payables/summary?year=${year}`, undefined, adminToken);
  assert.equal(sum.status, 200);
  assert.ok(sum.data.total_cents >= 60000, 'both paid payouts are counted');
  const csv = await fetch(`${BASE}/api/payables/summary?format=csv&year=${year}`, { headers: { Authorization: 'Bearer ' + adminToken } });
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(await csv.text(), /^contractor_id,name,email,payouts,total_usd/);
  assert.equal((await api('GET', '/api/payables/summary', undefined, custToken)).status, 403);
  const gen = await api('POST', '/api/payables/generate', {}, adminToken);
  assert.equal(gen.status, 200);
  assert.equal(typeof gen.data.created, 'number');
});

test('REGRESSION: campaigns — queue skips opt-outs, escapes names in the HTML, adds the unsubscribe footer, sends once', async () => {
  const unsub = require('../src/services/unsubscribe');
  // The 'all_customers' segment is built from people who SUBMITTED A REQUEST (job_requests), so create those.
  const request = (name, email, phone) => api('POST', '/api/jobs', { name, email, phone, address: '9 Test Rd', service_type: 'painting', description: 'Paint a bedroom, two coats please.' });
  const evil = await request('<b onmouseover=x>Mallory</b>', 'mallory@test.local', '555-808-9090'); // a name that tries to inject markup
  assert.equal(evil.status, 201);
  assert.equal((await request('Quiet Qa', 'quietqa@test.local', '555-808-9191')).status, 201);
  await unsub.suppress('quietqa@test.local', 'test opt-out');

  const tpl = await api('POST', '/api/campaigns/templates', { name: 'Spring promo', subject: 'Hello {{name}}', body_html: '<p>Hi {{name}}, 10% off in {{city}}!</p>' }, adminToken);
  assert.equal(tpl.status, 201);
  const camp = await api('POST', '/api/campaigns', { name: 'Spring', segment: 'all_customers', template_id: tpl.data.id }, adminToken);
  assert.equal(camp.status, 201);
  const q = await api('POST', `/api/campaigns/${camp.data.id}/queue`, {}, adminToken);
  assert.equal(q.status, 200);
  assert.ok(q.data.queued >= 1);
  assert.ok(q.data.skipped_unsubscribed >= 1, 'the opted-out address is skipped');

  const rows = await db.prepare('SELECT * FROM email_outbox WHERE campaign_id = ?').all(camp.data.id);
  const mal = rows.find(r => r.to_email === 'mallory@test.local');
  assert.ok(mal, 'the customer is queued');
  assert.ok(!/<b onmouseover/.test(mal.body_html), 'a name can never inject markup into the email');
  assert.match(mal.body_html, /&lt;b onmouseover=x&gt;Mallory&lt;\/b&gt;/);
  assert.match(mal.body_html, /\/api\/unsubscribe\?e=/, 'every promotional email carries the unsubscribe link');
  assert.ok(!rows.some(r => r.to_email === 'quietqa@test.local'), 'opted-out people are never queued');
  assert.ok(!/&lt;/.test(mal.subject), 'subjects are plain text, not HTML-escaped');

  // re-queue is idempotent
  const again = await api('POST', `/api/campaigns/${camp.data.id}/queue`, {}, adminToken);
  assert.equal(Number((await db.prepare('SELECT COUNT(*) c FROM email_outbox WHERE campaign_id = ?').get(camp.data.id)).c), rows.length, 'queueing twice does not duplicate');

  // send: console provider, each row delivered once; roles
  assert.equal((await api('POST', `/api/campaigns/${camp.data.id}/send`, {}, custToken)).status, 403);
  const sent = await api('POST', `/api/campaigns/${camp.data.id}/send`, {}, adminToken);
  assert.equal(sent.status, 200);
  const done = await db.prepare("SELECT COUNT(*) c FROM email_outbox WHERE campaign_id = ? AND status = 'sent'").get(camp.data.id);
  assert.ok(Number(done.c) >= 1, 'rows are marked sent');
  const list = await api('GET', '/api/campaigns', undefined, adminToken);
  assert.ok(list.data.find(c => c.id === camp.data.id).sent >= 1);
  // an opt-out that arrives AFTER queueing still blocks the send
  assert.equal((await request('Late Larry', 'larry@test.local', '555-808-9292')).status, 201);
  const camp2 = await api('POST', '/api/campaigns', { name: 'Second', segment: 'all_customers', template_id: tpl.data.id }, adminToken);
  await api('POST', `/api/campaigns/${camp2.data.id}/queue`, {}, adminToken);
  await unsub.suppress('larry@test.local', 'opted out after queueing');
  await api('POST', `/api/campaigns/${camp2.data.id}/send`, {}, adminToken);
  const larry = await db.prepare("SELECT status FROM email_outbox WHERE campaign_id = ? AND to_email = 'larry@test.local'").get(camp2.data.id);
  assert.notEqual(larry.status, 'sent', 'a late opt-out is honored at send time');
  // support may run campaigns (marketing), finance may not
  const fin = await makeStaff('finance', 'camp-fin@test.local');
  assert.equal((await api('GET', '/api/campaigns', undefined, fin.token)).status, 403);
});

test('REGRESSION: every report endpoint runs and returns JSON (admin/finance only)', async () => {
  for (const p of ['overview', 'funnel', 'contractor-funnel', 'margins', 'ticket', 'contractors', 'calibration', 'kpis']) {
    const r = await api('GET', `/api/reports/${p}`, undefined, adminToken);
    assert.equal(r.status, 200, `/api/reports/${p}`);
    assert.ok(r.data && typeof r.data === 'object', `${p} returns data`);
    assert.equal((await api('GET', `/api/reports/${p}`, undefined, custToken)).status, 403, `${p} is not for customers`);
  }
  const t = await api('GET', '/api/reports/ticket', undefined, adminToken);
  assert.ok(Array.isArray(t.data.by_month) && t.data.by_month.every(m => /^\d{4}-\d{2}$/.test(m.month)), 'months look like YYYY-MM');
  const fin = await makeStaff('support', 'rep-sup@test.local');
  assert.equal((await api('GET', '/api/reports/ticket', undefined, fin.token)).status, 403, 'support has no finance reports');
});

test('REGRESSION: CRM follow-up task generator runs and never duplicates an open task', async () => {
  const g1 = await api('POST', '/api/crm/tasks/generate', {}, adminToken);
  assert.equal(g1.status, 200);
  const n1 = Number((await db.prepare("SELECT COUNT(*) c FROM followup_tasks WHERE status = 'open'").get()).c);
  const g2 = await api('POST', '/api/crm/tasks/generate', {}, adminToken);
  assert.equal(g2.status, 200);
  const n2 = Number((await db.prepare("SELECT COUNT(*) c FROM followup_tasks WHERE status = 'open'").get()).c);
  assert.equal(n2, n1, 'a second run creates no duplicates');
  const sup = await makeStaff('finance', 'crm-fin@test.local');
  assert.equal((await api('POST', '/api/crm/tasks/generate', {}, sup.token)).status, 403, 'CRM needs the support permission');
});

test('REGRESSION: KPI dashboard endpoint returns every block with real numbers; admin only', async () => {
  assert.equal((await api('GET', '/api/reports/kpis', undefined, custToken)).status, 403);
  assert.equal((await api('GET', '/api/reports/kpis', undefined, contToken)).status, 403);
  assert.equal((await api('GET', '/api/reports/kpis')).status, 401);
  const k = await api('GET', '/api/reports/kpis?days=365', undefined, adminToken);
  assert.equal(k.status, 200);
  assert.equal(k.data.window.days, 365);
  for (const block of ['funnel', 'speed', 'sources', 'money', 'receivables', 'payables', 'quality', 'capacity', 'not_tracked']) {
    assert.ok(k.data[block] !== undefined, `${block} present`);
  }
  assert.ok(k.data.funnel.requests >= 1 && k.data.funnel.quoted >= 1 && k.data.funnel.accepted >= 1);
  assert.ok(k.data.funnel.accepted <= k.data.funnel.quoted && k.data.funnel.quoted <= k.data.funnel.requests, 'funnel never grows');
  assert.equal(typeof k.data.money.collected_cents, 'number');
  assert.ok(k.data.money.avg_ticket_cents > 0);
  assert.equal(typeof k.data.receivables.total_cents, 'number');
  assert.equal(typeof k.data.payables.owed_cents, 'number');
  assert.ok(k.data.capacity.active_projects >= 1);
  assert.ok(Array.isArray(k.data.not_tracked) && k.data.not_tracked.length > 0, 'it says what it does NOT measure');
  const bad = await api('GET', '/api/reports/kpis?days=banana', undefined, adminToken);
  assert.equal(bad.data.window.days, 30, 'invalid window falls back to 30 days');
});

// Helper: invite a staff member, let them set a password, sign them in.
async function makeStaff(role, email) {
  const inv = await api('POST', '/api/staff', { name: `${role} Person`, email, staff_role: role }, adminToken);
  assert.equal(inv.status, 201, `invite ${role}`);
  const u = await db.prepare('SELECT reset_token FROM users WHERE email = ?').get(email);
  assert.equal((await api('POST', '/api/auth/reset', { token: u.reset_token, password: 'StaffPass123!' })).status, 200);
  const lg = await api('POST', '/api/auth/login', { email, password: 'StaffPass123!' });
  assert.equal(lg.status, 200);
  return { id: inv.data.id, token: lg.data.token };
}

test('REGRESSION: team roles — support, finance and dispatch each reach only their own area', async () => {
  // only owners manage the team; invites are validated
  assert.equal((await api('GET', '/api/staff', undefined, custToken)).status, 403);
  assert.equal((await api('GET', '/api/staff', undefined, contToken)).status, 403);
  assert.equal((await api('POST', '/api/staff', { name: 'X', email: 'x@test.local', staff_role: 'god' }, adminToken)).status, 422);
  const sup = await makeStaff('support', 'sup@test.local');
  const fin = await makeStaff('finance', 'fin@test.local');
  const dis = await makeStaff('dispatch', 'dis@test.local');
  assert.equal((await api('POST', '/api/staff', { name: 'Dup', email: 'sup@test.local', staff_role: 'support' }, adminToken)).status, 409);
  assert.equal((await api('GET', '/api/staff', undefined, sup.token)).status, 403, 'support cannot manage the team');

  const me = await api('GET', '/api/auth/me', undefined, sup.token);
  assert.equal(me.data.staff_role, 'support');
  assert.ok(me.data.permissions.includes('support') && !me.data.permissions.includes('finance'));
  const owner = await api('GET', '/api/auth/me', undefined, adminToken);
  assert.equal(owner.data.staff_role, 'owner', 'a pre-existing admin is an owner');

  // ---- support: customers yes, money / dispatch / costs no ----
  assert.equal((await api('GET', '/api/jobs', undefined, sup.token)).status, 200);
  assert.equal((await api('GET', '/api/campaigns', undefined, sup.token)).status, 200);
  assert.equal((await api('GET', '/api/reports/kpis', undefined, sup.token)).status, 403);
  assert.equal((await api('GET', '/api/payables', undefined, sup.token)).status, 403);
  assert.equal((await api('POST', '/api/payments', { project_id: projectId, kind: 'final', amount_cents: 100 }, sup.token)).status, 403);
  assert.equal((await api('POST', '/api/payments/1/refund', {}, sup.token)).status, 403);
  assert.equal((await api('POST', `/api/projects/${projectId}/assign`, { contractor_id: contractorId }, sup.token)).status, 403);
  assert.equal((await api('PATCH', `/api/projects/${projectId}/stage`, { stage: 'review' }, sup.token)).status, 403);
  assert.equal((await api('GET', '/api/crm/audit', undefined, sup.token)).status, 403, 'audit log is owner only');
  const supView = await api('GET', `/api/projects/${projectId}`, undefined, sup.token);
  assert.equal(supView.status, 200);
  assert.equal(supView.data.contractor_cost_cents, undefined, 'support never sees the contractor cost');
  assert.ok(supView.data.customer_price_cents > 0);

  // ---- finance: money yes, operations / marketing no ----
  assert.equal((await api('GET', '/api/reports/kpis', undefined, fin.token)).status, 200);
  assert.equal((await api('GET', '/api/payables', undefined, fin.token)).status, 200);
  assert.equal((await api('GET', '/api/jobs', undefined, fin.token)).status, 200);
  assert.equal((await api('GET', '/api/campaigns', undefined, fin.token)).status, 403);
  assert.equal((await api('POST', `/api/projects/${projectId}/assign`, { contractor_id: contractorId }, fin.token)).status, 403);
  assert.ok((await api('GET', `/api/projects/${projectId}`, undefined, fin.token)).data.contractor_cost_cents > 0, 'finance sees costs');

  // ---- dispatch: operations yes, money no ----
  assert.equal((await api('GET', '/api/projects/schedule', undefined, dis.token)).status, 200);
  assert.notEqual((await api('POST', `/api/projects/${projectId}/assign`, { contractor_id: 999999 }, dis.token)).status, 403, 'dispatch may assign (bad id fails for another reason)');
  assert.equal((await api('GET', '/api/reports/kpis', undefined, dis.token)).status, 403);
  assert.equal((await api('GET', '/api/payables', undefined, dis.token)).status, 403);
  assert.equal((await api('POST', '/api/payments', { project_id: projectId, kind: 'final', amount_cents: 100 }, dis.token)).status, 403);
  assert.ok((await api('GET', `/api/projects/${projectId}`, undefined, dis.token)).data.contractor_cost_cents > 0);

  // ---- owner keeps everything ----
  assert.equal((await api('GET', '/api/reports/kpis', undefined, adminToken)).status, 200);
  assert.equal((await api('GET', '/api/crm/audit', undefined, adminToken)).status, 200);

  // ---- role changes apply immediately; the last owner is protected ----
  assert.equal((await api('PATCH', `/api/staff/${sup.id}`, { staff_role: 'finance' }, adminToken)).status, 200);
  assert.equal((await api('GET', '/api/payables', undefined, sup.token)).status, 200, 'new role takes effect without signing in again');
  assert.equal((await api('PATCH', `/api/staff/${owner.data.id}`, { staff_role: 'support' }, adminToken)).status, 409, 'cannot demote the last owner');
  assert.equal((await api('POST', `/api/staff/${owner.data.id}/deactivate`, {}, adminToken)).status, 409, 'cannot deactivate yourself');

  // ---- deactivation signs the person out everywhere ----
  assert.equal((await api('POST', `/api/staff/${dis.id}/deactivate`, {}, adminToken)).status, 200);
  assert.equal((await api('GET', '/api/auth/me', undefined, dis.token)).status, 401);
  assert.equal((await api('POST', '/api/auth/login', { email: 'dis@test.local', password: 'StaffPass123!' })).status, 403);
  assert.ok(await db.prepare("SELECT id FROM admin_audit WHERE action = 'staff.deactivated' AND entity_id = ?").get(dis.id));
});

test('REGRESSION: two-step verification — password alone is not enough, codes work once, recovery works once', async () => {
  const totp = require('../src/services/totp');
  const email = 'tfa@test.local';
  const st = await makeStaff('support', email);
  const login = () => api('POST', '/api/auth/login', { email, password: 'StaffPass123!' });
  assert.ok((await login()).data.token, 'before enrolling, the password opens a session');

  // enrol
  assert.equal((await api('POST', '/api/auth/2fa/setup', undefined, custToken)).status, 403, 'staff only');
  const setup = await api('POST', '/api/auth/2fa/setup', undefined, st.token);
  assert.equal(setup.status, 200);
  assert.match(setup.data.otpauth_url, /^otpauth:\/\/totp\//);
  const stored = await db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(st.id);
  assert.ok(stored.totp_secret && !stored.totp_secret.includes(setup.data.secret), 'secret is stored encrypted');
  assert.equal((await api('POST', '/api/auth/2fa/enable', { code: '000000' }, st.token)).status, 422);
  const en = await api('POST', '/api/auth/2fa/enable', { code: totp.codeAt(setup.data.secret, Date.now()) }, st.token);
  assert.equal(en.status, 200);
  assert.equal(en.data.recovery_codes.length, 8);
  const rec = await db.prepare('SELECT totp_recovery FROM users WHERE id = ?').get(st.id);
  assert.ok(!rec.totp_recovery.includes(en.data.recovery_codes[0]), 'recovery codes are stored hashed');

  // step 1 gives NO session; the challenge cannot be used as a bearer token
  const l1 = await login();
  assert.equal(l1.data.two_factor_required, true);
  assert.equal(l1.data.token, undefined);
  assert.equal((await api('GET', '/api/auth/me', undefined, l1.data.challenge)).status, 401, 'a challenge is not a session');
  // step 2
  assert.equal((await api('POST', '/api/auth/2fa/verify', { challenge: l1.data.challenge, code: '123456' })).status, 401);
  assert.equal((await api('POST', '/api/auth/2fa/verify', { challenge: 'garbage', code: '123456' })).status, 401);
  // The code used to ENABLE 2FA is spent for its 30 s window (anti-replay), so the first sign-in uses the next one.
  const code = totp.codeAt(setup.data.secret, Date.now() + 30000);
  assert.equal((await api('POST', '/api/auth/2fa/verify', { challenge: l1.data.challenge, code: totp.codeAt(setup.data.secret, Date.now()) })).status, 401, 'the enrolment code cannot be reused to sign in');
  const v1 = await api('POST', '/api/auth/2fa/verify', { challenge: l1.data.challenge, code });
  assert.equal(v1.status, 200);
  assert.equal((await api('GET', '/api/auth/me', undefined, v1.data.token)).data.totp_enabled, true);
  // the same code cannot open a second session (anti-replay)
  const l2 = await login();
  assert.equal((await api('POST', '/api/auth/2fa/verify', { challenge: l2.data.challenge, code })).status, 401, 'a used code is dead');
  // (Only one TOTP sign-in fits in each 30 s window: a second one needs a code from a LATER step.)

  // recovery code: works once
  const l3 = await login();
  const r1 = await api('POST', '/api/auth/2fa/verify', { challenge: l3.data.challenge, code: en.data.recovery_codes[0] });
  assert.equal(r1.status, 200);
  assert.equal(r1.data.recovery_codes_left, 7);
  const l4 = await login();
  assert.equal((await api('POST', '/api/auth/2fa/verify', { challenge: l4.data.challenge, code: en.data.recovery_codes[0] })).status, 401, 'recovery code is single use');

  // turning it off needs password + code
  assert.equal((await api('POST', '/api/auth/2fa/disable', { password: 'wrong', code: en.data.recovery_codes[1] }, v1.data.token)).status, 403);
  assert.equal((await api('POST', '/api/auth/2fa/disable', { password: 'StaffPass123!', code: '111111' }, v1.data.token)).status, 422);
  assert.equal((await api('POST', '/api/auth/2fa/disable', { password: 'StaffPass123!', code: en.data.recovery_codes[1] }, v1.data.token)).status, 200);
  assert.ok((await login()).data.token, 'after turning it off, the password opens a session again');
});

test('REGRESSION: with the 2FA policy on, money and team areas stay locked until the person enrols', async () => {
  const totp = require('../src/services/totp');
  const fin = await makeStaff('finance', 'fin2@test.local');
  const sup = await makeStaff('support', 'sup2@test.local');
  process.env.REQUIRE_2FA = 'true';
  try {
    const locked = await api('GET', '/api/payables', undefined, fin.token);
    assert.equal(locked.status, 403);
    assert.equal(locked.data.code, 'MFA_REQUIRED');
    assert.equal((await api('GET', '/api/reports/kpis', undefined, adminToken)).data.code, 'MFA_REQUIRED', 'owners are held to it too');
    assert.equal((await api('GET', '/api/staff', undefined, adminToken)).data.code, 'MFA_REQUIRED');
    const me = await api('GET', '/api/auth/me', undefined, fin.token);
    assert.equal(me.data.mfa_required, true);
    assert.equal(me.data.totp_enabled, false);
    // areas that do not move money are untouched
    assert.equal((await api('GET', '/api/jobs', undefined, sup.token)).status, 200);
    assert.equal((await api('GET', '/api/auth/me', undefined, sup.token)).data.mfa_required, false);
    // enrol -> unlocked
    const s = await api('POST', '/api/auth/2fa/setup', undefined, fin.token);
    assert.equal((await api('POST', '/api/auth/2fa/enable', { code: totp.codeAt(s.data.secret, Date.now()) }, fin.token)).status, 200);
    assert.equal((await api('GET', '/api/payables', undefined, fin.token)).status, 200);
  } finally {
    delete process.env.REQUIRE_2FA;
  }
  // (policy off again) an owner resets a colleague who lost their phone: sessions die, the password logs in directly
  const before = await api('GET', '/api/staff', undefined, adminToken);
  assert.equal(before.data.find(x => x.id === fin.id).totp_enabled, true);
  const rs = await api('POST', `/api/staff/${fin.id}/reset-2fa`, {}, adminToken);
  assert.equal(rs.status, 200);
  assert.equal((await api('GET', '/api/auth/me', undefined, fin.token)).status, 401, 'their old session is revoked');
  const again = await api('POST', '/api/auth/login', { email: 'fin2@test.local', password: 'StaffPass123!' });
  assert.ok(again.data.token && !again.data.two_factor_required);
  assert.ok(await db.prepare("SELECT id FROM admin_audit WHERE action = 'staff.2fa_reset' AND entity_id = ?").get(fin.id));
});

// Helper: a project that is in progress with an accepted contractor (a dispute can be opened on it).
async function activeProject() {
  const fp = await freshProject();
  const pid = fp.projectId;
  assert.equal((await api('POST', `/api/projects/${pid}/assign`, { contractor_id: contractorId }, adminToken)).status, 200);
  assert.equal((await api('POST', `/api/projects/${pid}/contractor-respond`, { accept: true, terms_accepted: true }, contToken)).status, 200);
  assert.equal((await api('PATCH', `/api/projects/${pid}/stage`, { stage: 'in_progress' }, contToken)).status, 200);
  return pid;
}

test('REGRESSION: disputes — hold, separate channels, finance-only refunds, payout adjustment', async () => {
  const pid = await activeProject();
  const desc = 'The tile work is uneven and there are gaps along the wall.';
  // who may open, and validation
  assert.equal((await api('POST', '/api/disputes', { project_id: pid, reason: 'quality', description: 'bad' }, custToken)).status, 422);
  assert.equal((await api('POST', '/api/disputes', { project_id: pid, reason: 'nonsense', description: desc }, custToken)).status, 422);
  assert.equal((await api('POST', '/api/disputes', { project_id: pid, reason: 'quality', description: desc }, adminToken)).status, 403, 'staff do not open disputes');
  const stranger = await api('POST', '/api/auth/signup/customer', { name: 'Stranger', email: 'stranger@test.local', phone: '555-303-4040', password: 'Customer123!' });
  assert.equal((await api('POST', '/api/disputes', { project_id: pid, reason: 'quality', description: desc }, stranger.data.token)).status, 403, 'only the project\'s own customer');
  // open (one at a time)
  const open = await api('POST', '/api/disputes', { project_id: pid, reason: 'quality', description: desc }, custToken);
  assert.equal(open.status, 201);
  const did = open.data.id;
  assert.equal(open.data.opened_by, undefined, 'customer view hides internals');
  assert.equal((await api('POST', '/api/disputes', { project_id: pid, reason: 'other', description: desc }, custToken)).status, 409);
  assert.equal((await api('GET', `/api/disputes/${did}`, undefined, stranger.data.token)).status, 404);

  // contractor sees the fact of the dispute, never the complaint text
  const cv = await api('GET', `/api/disputes/${did}`, undefined, contToken);
  assert.equal(cv.status, 200);
  assert.equal(cv.data.description, undefined);
  assert.equal(cv.data.reason, 'quality');

  // channels: customer and contractor never see each other's messages
  assert.equal((await api('POST', `/api/disputes/${did}/comments`, { body: 'Here is more detail from my side.' }, custToken)).status, 201);
  assert.equal((await api('POST', `/api/disputes/${did}/comments`, { body: 'We went to the site; the wall was not level.' }, contToken)).status, 201);
  const sup = await makeStaff('support', 'dsup@test.local');
  const fin = await makeStaff('finance', 'dfin@test.local');
  assert.equal((await api('POST', `/api/disputes/${did}/comments`, { body: 'Internal: check photos', visibility: 'staff' }, sup.token)).status, 201);
  assert.equal((await api('POST', `/api/disputes/${did}/comments`, { body: 'Can you send photos of the wall?', visibility: 'contractor' }, sup.token)).status, 201);
  assert.equal((await api('POST', `/api/disputes/${did}/comments`, { body: 'We are looking into it.' }, fin.token)).status, 403, 'finance has no support permission');
  const bodies = (r) => r.data.events.map(e => e.body).join(' | ');
  const custEv = bodies(await api('GET', `/api/disputes/${did}`, undefined, custToken));
  const contEv = bodies(await api('GET', `/api/disputes/${did}`, undefined, contToken));
  const adminEv = bodies(await api('GET', `/api/disputes/${did}`, undefined, adminToken));
  assert.ok(custEv.includes('more detail') && !custEv.includes('not level') && !custEv.includes('Internal') && !custEv.includes('photos of the wall'));
  assert.ok(contEv.includes('not level') && contEv.includes('photos of the wall') && !contEv.includes('more detail') && !contEv.includes('Internal'));
  assert.ok(['more detail', 'not level', 'Internal', 'photos of the wall'].every(s => adminEv.includes(s)), 'staff sees every channel');

  // HOLD: the contractor cannot be paid while the dispute is open
  assert.equal((await api('PATCH', `/api/projects/${pid}/stage`, { stage: 'completed', force: true }, adminToken)).status, 200);
  const pb = (await api('GET', '/api/payables', undefined, adminToken)).data.payables.find(r => r.project_id === pid);
  assert.equal(pb.status, 'pending');
  const held = await api('POST', `/api/payables/${pb.id}/pay`, { method: 'ach', force: true }, adminToken);
  assert.equal(held.status, 409);
  assert.equal(held.data.code, 'DISPUTE_HOLD');

  // investigate; refunds are a FINANCE decision
  assert.equal((await api('POST', `/api/disputes/${did}/status`, { status: 'investigating' }, sup.token)).status, 200);
  assert.equal((await api('POST', `/api/disputes/${did}/status`, { status: 'investigating' }, sup.token)).status, 409);
  const refundBody = { resolution: 'partial_refund', refund_cents: 5000, notes: 'Part of the tile will be redone at our cost; we refund part of the price.', payable_action: 'reduce', payable_cents: 20000 };
  assert.equal((await api('POST', `/api/disputes/${did}/resolve`, refundBody, sup.token)).status, 403, 'support cannot refund');
  assert.equal((await api('POST', `/api/disputes/${did}/resolve`, { resolution: 'partial_refund', notes: 'x' }, fin.token)).status, 422, 'amount required');
  const tooMuch = await api('POST', `/api/disputes/${did}/resolve`, { ...refundBody, refund_cents: 99999 }, fin.token);
  assert.equal(tooMuch.status, 409);
  assert.equal(tooMuch.data.max_refund_cents, 15000, 'cannot refund more than the customer paid');
  const done = await api('POST', `/api/disputes/${did}/resolve`, refundBody, fin.token);
  assert.equal(done.status, 200);
  assert.equal(done.data.refund.total_cents, 5000);
  assert.equal(done.data.refund.manual_cents, 5000, 'Stripe is off: recorded as a manual refund');
  assert.equal(done.data.payable.action, 'reduced');
  assert.equal((await api('POST', `/api/disputes/${did}/resolve`, refundBody, fin.token)).status, 409, 'cannot resolve twice');
  const refunds = (await api('GET', `/api/payments?project_id=${pid}`, undefined, adminToken)).data.filter(r => r.kind === 'refund');
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].amount_cents, 5000);
  assert.match(refunds[0].notes, new RegExp(`Dispute #${did} `));
  assert.equal((await api('GET', '/api/payables', undefined, adminToken)).data.payables.find(r => r.id === pb.id).payable_cents, 20000);

  // who sees what after the decision
  const cAfter = await api('GET', `/api/disputes/${did}`, undefined, custToken);
  assert.equal(cAfter.data.refund_cents, 5000);
  assert.ok(cAfter.data.resolution_notes);
  const kAfter = await api('GET', `/api/disputes/${did}`, undefined, contToken);
  assert.equal(kAfter.data.resolution, 'resolved_with_adjustment', 'contractor is not told the refund amount');
  assert.equal(kAfter.data.refund_cents, undefined);
  assert.equal(kAfter.data.resolution_notes, undefined);

  // hold is lifted: the payout can now be paid (the customer still owes, so it needs the override)
  assert.equal((await api('POST', `/api/payables/${pb.id}/pay`, { method: 'ach', force: true }, adminToken)).status, 200);
  assert.ok(await db.prepare("SELECT id FROM admin_audit WHERE action = 'dispute.resolved' AND entity_id = ?").get(did));
  // closed disputes accept no more messages
  assert.equal((await api('POST', `/api/disputes/${did}/comments`, { body: 'one more thing please' }, custToken)).status, 409);
});

test('REGRESSION: disputes — contractor can open, opener can withdraw, rework reopens the job, full refund can cancel the payout', async () => {
  // contractor-opened; withdraw
  const p1 = await activeProject();
  const co = await api('POST', '/api/disputes', { project_id: p1, reason: 'incomplete', description: 'The customer will not approve finished work.' }, contToken);
  assert.equal(co.status, 201);
  assert.equal(co.data.opened_by_role, 'contractor');
  const custSees = await api('GET', `/api/disputes/${co.data.id}`, undefined, custToken);
  assert.equal(custSees.data.description, undefined, 'the customer does not read the contractor\'s complaint');
  assert.equal((await api('POST', `/api/disputes/${co.data.id}/withdraw`, {}, custToken)).status, 404, 'only the opener withdraws');
  assert.equal((await api('POST', `/api/disputes/${co.data.id}/withdraw`, {}, contToken)).status, 200);
  assert.equal((await api('POST', `/api/disputes/${co.data.id}/withdraw`, {}, contToken)).status, 409);
  const list = await api('GET', '/api/disputes?status=withdrawn', undefined, adminToken);
  assert.ok(list.data.some(d => d.id === co.data.id));

  // rework: support may resolve (no money); the project goes back to in_progress
  const p2 = await activeProject();
  await api('PATCH', `/api/projects/${p2}/stage`, { stage: 'review' }, contToken);
  const d2 = await api('POST', '/api/disputes', { project_id: p2, reason: 'quality', description: 'The paint is peeling after two days.' }, custToken);
  const sup = await makeStaff('dispatch', 'ddis@test.local');
  const rw = await api('POST', `/api/disputes/${d2.data.id}/resolve`, { resolution: 'rework', notes: 'The contractor will repaint the wall.' }, sup.token);
  assert.equal(rw.status, 200);
  assert.equal((await db.prepare('SELECT stage FROM projects WHERE id = ?').get(p2)).stage, 'in_progress');
  assert.equal((await api('POST', `/api/disputes/${d2.data.id}/resolve`, { resolution: 'no_action', notes: 'again' }, sup.token)).status, 409);

  // full refund + cancel the payout; payout changes are finance-only
  const p3 = await activeProject();
  await api('PATCH', `/api/projects/${p3}/stage`, { stage: 'completed', force: true }, adminToken);
  const d3 = await api('POST', '/api/disputes', { project_id: p3, reason: 'no_show', description: 'Nobody ever came to finish the job.' }, custToken);
  const noMoney = await api('POST', `/api/disputes/${d3.data.id}/resolve`, { resolution: 'no_action', notes: 'cancel their pay', payable_action: 'cancel' }, sup.token);
  assert.equal(noMoney.status, 403, 'dispatch cannot change payouts');
  const fin = await makeStaff('finance', 'dfin2@test.local');
  const full = await api('POST', `/api/disputes/${d3.data.id}/resolve`, { resolution: 'full_refund', notes: 'Full refund; the work was not done.', payable_action: 'cancel' }, fin.token);
  assert.equal(full.status, 200);
  assert.equal(full.data.refund.total_cents, 15000, 'full = everything the customer paid, net');
  assert.equal(full.data.payable.action, 'cancelled');
  const pb3 = (await api('GET', '/api/payables', undefined, adminToken)).data.payables.find(r => r.project_id === p3);
  assert.equal(pb3.status, 'cancelled');
});

test('REGRESSION: KPI dashboard counts disputes', async () => {
  const k = await api('GET', '/api/reports/kpis?days=365', undefined, adminToken);
  assert.ok(k.data.quality.disputes_opened >= 1);
  assert.equal(typeof k.data.quality.dispute_rate_pct, 'number');
  assert.ok(k.data.quality.refunded_by_disputes_cents >= 20000, 'refunds from the resolved disputes are counted');
});

test('REGRESSION: SMS only goes to customers who opted in; "on my way", visit outcomes and the STOP reply work', async () => {
  const sms = require('../src/services/sms');
  const pid = await activeProject();
  const logFor = (kind) => db.prepare('SELECT * FROM sms_log WHERE project_id = ? AND kind = ? ORDER BY id DESC').all(pid, kind);
  assert.equal((await api('POST', `/api/projects/${pid}/on-my-way`, {}, custToken)).status, 403, 'customers cannot trigger it');

  // 1) no consent -> nothing is sent, and it is logged as skipped
  const none = await api('POST', `/api/projects/${pid}/on-my-way`, {}, contToken);
  assert.equal(none.status, 200);
  assert.equal(none.data.sent, false);
  assert.equal(none.data.reason, 'no_consent');
  assert.equal((await logFor('on_my_way'))[0].status, 'skipped_no_consent');

  // 2) the customer opts in from the portal
  const st = await api('GET', '/api/sms/status', undefined, custToken);
  assert.ok(st.data.phone && st.data.phone.startsWith('+'), 'phone is normalized to E.164');
  assert.equal((await api('POST', '/api/sms/opt-in', { opt_in: true }, custToken)).data.opted_in, true);
  // the request form also records consent when the box is ticked
  const g = await api('POST', '/api/jobs', { name: 'Texty', phone: '(707) 555-0199', email: 'texty@test.local', address: '5 Oak St',
    service_type: 'painting', description: 'Paint one room, please.', sms_consent: true });
  assert.equal(g.status, 201);
  assert.equal(await sms.hasConsent('+17075550199'), true);
  const g2 = await api('POST', '/api/jobs', { name: 'Quiet', phone: '(707) 555-0188', email: 'quiet@test.local', address: '6 Oak St',
    service_type: 'painting', description: 'Paint one room, please.' });
  assert.equal(await sms.hasConsent('+17075550188'), false, 'consent is never assumed');

  // 3) on my way: sent once, throttled, and the technician's number is never in the text
  const ok = await api('POST', `/api/projects/${pid}/on-my-way`, {}, contToken);
  assert.equal(ok.data.sent, true);
  const row = (await logFor('on_my_way'))[0];
  assert.equal(row.status, 'sent');
  assert.equal(row.provider, 'console');
  assert.match(row.body, /on the way/);
  assert.match(row.body, /Reply STOP/);
  assert.ok(!/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/.test(row.body), 'no phone number in the text');
  assert.equal((await api('POST', `/api/projects/${pid}/on-my-way`, {}, contToken)).status, 409, 'throttled: 1 text per 30 minutes');

  // 4) visit outcomes
  assert.equal((await api('POST', `/api/projects/${pid}/visit-outcome`, { outcome: 'banana' }, contToken)).status, 422);
  assert.equal((await api('POST', `/api/projects/${pid}/visit-outcome`, { outcome: 'completed' }, custToken)).status, 403);
  assert.equal((await api('POST', `/api/projects/${pid}/visit-outcome`, { outcome: 'completed' }, contToken)).status, 201);
  assert.equal((await api('POST', `/api/projects/${pid}/visit-outcome`, { outcome: 'customer_no_show', note: 'Nobody home' }, contToken)).status, 201);
  assert.equal((await logFor('missed_visit'))[0].status, 'sent', 'a missed visit texts the customer');

  // 5) scheduling confirms by text; moving the date counts as a reschedule
  assert.equal((await api('PATCH', `/api/projects/${pid}/schedule`, { scheduled_start: '2027-05-10', scheduled_end: '2027-05-10' }, adminToken)).status, 200);
  assert.equal((await logFor('scheduled'))[0].status, 'sent');
  assert.match((await logFor('scheduled'))[0].body, /Monday, May 10/);
  assert.equal((await api('PATCH', `/api/projects/${pid}/schedule`, { scheduled_start: '2027-05-12', scheduled_end: '2027-05-12' }, adminToken)).status, 200);
  const resched = await db.prepare("SELECT COUNT(*) c FROM visit_events WHERE project_id = ? AND outcome = 'rescheduled'").get(pid);
  assert.equal(Number(resched.c), 1);

  // 6) Twilio inbound: needs configuration and a valid signature; STOP turns texts off
  delete process.env.TWILIO_AUTH_TOKEN;
  const form = (b) => new URLSearchParams(b);
  const post = (b, sig) => fetch(`${BASE}/api/sms/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(sig ? { 'X-Twilio-Signature': sig } : {}) }, body: form(b) });
  assert.equal((await post({ Body: 'STOP', From: st.data.phone })).status, 503, 'refuses when not configured');
  process.env.TWILIO_AUTH_TOKEN = 'test-token-123';
  const prevUrl = process.env.PUBLIC_URL;
  process.env.PUBLIC_URL = 'http://sms.test';
  try {
    const params = { Body: 'STOP', From: st.data.phone };
    assert.equal((await post(params, 'forged')).status, 403);
    assert.equal((await post(params)).status, 403, 'unsigned requests are refused');
    const sig = sms.twilioSignature('http://sms.test/api/sms/inbound', params, 'test-token-123');
    assert.equal((await post(params, sig)).status, 200);
    assert.equal((await api('GET', '/api/sms/status', undefined, custToken)).data.opted_in, false, 'STOP opts out immediately');
    const start = { Body: 'start', From: st.data.phone };
    assert.equal((await post(start, sms.twilioSignature('http://sms.test/api/sms/inbound', start, 'test-token-123'))).status, 200);
    assert.equal((await api('GET', '/api/sms/status', undefined, custToken)).data.opted_in, true, 'START opts back in (case-insensitive)');
  } finally {
    delete process.env.TWILIO_AUTH_TOKEN;
    if (prevUrl === undefined) delete process.env.PUBLIC_URL; else process.env.PUBLIC_URL = prevUrl;
  }
});

test('REGRESSION: day-before reminders go once, only in the daytime window, only for staff with dispatch', async () => {
  const sms = require('../src/services/sms');
  await api('POST', '/api/sms/opt-in', { opt_in: true }, custToken);
  // A visit that has not started yet: assigned/scheduled (reminders are for upcoming visits, not work in progress).
  const fp = await freshProject();
  const pid = fp.projectId;
  assert.equal((await api('POST', `/api/projects/${pid}/assign`, { contractor_id: contractorId }, adminToken)).status, 200);
  assert.equal((await api('POST', `/api/projects/${pid}/contractor-respond`, { accept: true, terms_accepted: true }, contToken)).status, 200);
  assert.ok(['assigned', 'scheduled'].includes((await db.prepare('SELECT stage FROM projects WHERE id = ?').get(pid)).stage));
  const tomorrow = sms.tomorrowIn(process.env.BUSINESS_TZ || 'America/Los_Angeles', new Date());
  assert.equal((await api('PATCH', `/api/projects/${pid}/schedule`, { scheduled_start: tomorrow, scheduled_end: tomorrow }, adminToken)).status, 200);
  const sup = await makeStaff('support', 'smssup@test.local');
  assert.equal((await api('POST', '/api/sms/run-reminders', { force: true }, sup.token)).status, 403, 'dispatch is required');
  assert.equal((await api('POST', '/api/sms/run-reminders', { force: true }, custToken)).status, 403);

  const r1 = await api('POST', '/api/sms/run-reminders', { force: true }, adminToken);
  assert.equal(r1.status, 200);
  assert.equal(r1.data.for_date, tomorrow);
  const sent = () => db.prepare("SELECT COUNT(*) c FROM sms_log WHERE project_id = ? AND kind = 'reminder' AND status = 'sent'").get(pid);
  assert.equal(Number((await sent()).c), 1, 'reminder sent');
  assert.ok((await db.prepare('SELECT reminder_sent_at FROM projects WHERE id = ?').get(pid)).reminder_sent_at);
  await api('POST', '/api/sms/run-reminders', { force: true }, adminToken);
  assert.equal(Number((await sent()).c), 1, 'running again never reminds twice');
  assert.match((await db.prepare("SELECT body FROM sms_log WHERE project_id = ? AND kind = 'reminder'").get(pid)).body, /tomorrow/);

  // moving the date re-arms the reminder
  const later = sms.tomorrowIn('UTC', new Date(Date.now() + 5 * 86400000));
  await api('PATCH', `/api/projects/${pid}/schedule`, { scheduled_start: later, scheduled_end: later }, adminToken);
  assert.equal((await db.prepare('SELECT reminder_sent_at FROM projects WHERE id = ?').get(pid)).reminder_sent_at, null);

  // outside 9:00-19:00 business time nothing is sent (03:00 in Los Angeles)
  const night = await sms.runReminders({ now: new Date('2026-10-11T10:00:00Z') });
  assert.ok(night.skipped, 'night window is respected');
  assert.equal(night.sent, 0);

  // log is visible to staff, hidden from customers
  const lg = await api('GET', '/api/sms/log', undefined, adminToken);
  assert.equal(lg.status, 200);
  assert.ok(lg.data.length >= 1);
  assert.equal((await api('GET', '/api/sms/log', undefined, custToken)).status, 403);
});

test('REGRESSION: KPIs count visit outcomes; deleting an account stops its texts', async () => {
  const k = await api('GET', '/api/reports/kpis?days=365', undefined, adminToken);
  assert.ok(k.data.visits.logged >= 3);
  assert.ok(k.data.visits.customer_no_show >= 1 && k.data.visits.rescheduled >= 1);
  assert.equal(typeof k.data.visits.no_show_rate_pct, 'number');

  const sms = require('../src/services/sms');
  const c = await api('POST', '/api/auth/signup/customer', { name: 'Bye Texts', email: 'byetexts@test.local', phone: '(707) 555-0155', password: 'Customer123!' });
  assert.equal((await api('POST', '/api/sms/opt-in', { opt_in: true }, c.data.token)).status, 200);
  assert.equal(await sms.hasConsent('+17075550155'), true);
  await sms.send({ phone: '+17075550155', body: 'hello', kind: 'test' });
  const exp = await api('GET', '/api/me/export', undefined, c.data.token);
  assert.equal(exp.data.sms_consent.opted_in, true, 'export includes the text consent');
  assert.equal((await api('POST', '/api/me/delete', { password: 'Customer123!' }, c.data.token)).status, 200);
  assert.equal(await sms.hasConsent('+17075550155'), false, 'no more texts after deletion');
  assert.equal(Number((await db.prepare("SELECT COUNT(*) c FROM sms_log WHERE to_phone = '+17075550155'").get()).c), 0, 'their message history is erased');
});

test('REGRESSION: AI reply drafts — staff only, never auto-sent, rate-limited, human decision recorded', async () => {
  const keep = { k: process.env.OPENAI_API_KEY, e: process.env.AI_ENABLED, l: process.env.AI_DRAFTS_PER_HOUR };
  process.env.AI_ENABLED = 'false'; // never reach a real provider from the test suite
  try {
    const sup = await makeStaff('support', 'ai1@test.local');
    const fin = await makeStaff('finance', 'ai-fin@test.local');
    assert.equal((await api('POST', '/api/ai/drafts', { thread_id: csThread })).status, 401);
    assert.equal((await api('POST', '/api/ai/drafts', { thread_id: csThread }, custToken)).status, 403);
    assert.equal((await api('POST', '/api/ai/drafts', { thread_id: csThread }, contToken)).status, 403);
    assert.equal((await api('POST', '/api/ai/drafts', { thread_id: csThread }, fin.token)).status, 403, 'finance has no support permission');
    assert.equal((await api('POST', '/api/ai/drafts', {}, sup.token)).status, 422);
    assert.equal((await api('POST', '/api/ai/drafts', { thread_id: 999999 }, sup.token)).status, 404);

    const before = Number((await db.prepare('SELECT COUNT(*) c FROM messages WHERE thread_id = ?').get(csThread)).c);
    const d = await api('POST', '/api/ai/drafts', { thread_id: csThread }, sup.token);
    assert.equal(d.status, 201);
    assert.equal(d.data.provider, 'heuristic', 'no AI configured: it says it is a template');
    assert.equal(d.data.audience, 'customer');
    assert.ok(d.data.body.length > 20);
    assert.match(d.data.note, /Template draft/);
    assert.ok(!/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}|@/.test(d.data.body), 'no contact details in a draft');
    const after = Number((await db.prepare('SELECT COUNT(*) c FROM messages WHERE thread_id = ?').get(csThread)).c);
    assert.equal(after, before, 'creating a draft sends NOTHING');

    // the human's decision is recorded
    assert.equal((await api('POST', `/api/ai/drafts/${d.data.id}/mark`, { status: 'sent', final_body: 'x' }, fin.token)).status, 403);
    assert.equal((await api('POST', `/api/ai/drafts/${d.data.id}/mark`, { status: 'banana' }, sup.token)).status, 422);
    assert.equal((await api('POST', `/api/ai/drafts/${d.data.id}/mark`, { status: 'sent' }, sup.token)).status, 422, 'must say what was actually sent');
    const other = await makeStaff('support', 'ai-other@test.local');
    assert.equal((await api('POST', `/api/ai/drafts/${d.data.id}/mark`, { status: 'discarded' }, other.token)).status, 404, 'only the author');
    const edited = await api('POST', `/api/ai/drafts/${d.data.id}/mark`, { status: 'sent', final_body: d.data.body + ' Thank you for your patience.' }, sup.token);
    assert.equal(edited.status, 200);
    assert.equal(edited.data.edited, true);
    assert.ok(edited.data.similarity > 0 && edited.data.similarity < 1);
    assert.equal((await api('POST', `/api/ai/drafts/${d.data.id}/mark`, { status: 'discarded' }, sup.token)).status, 409, 'decided once');
    const d2 = await api('POST', '/api/ai/drafts', { thread_id: csThread }, sup.token);
    assert.equal((await api('POST', `/api/ai/drafts/${d2.data.id}/mark`, { status: 'sent', final_body: d2.data.body }, sup.token)).data.edited, false, 'sent as suggested');
    const d3 = await api('POST', '/api/ai/drafts', { thread_id: csThread }, sup.token);
    assert.equal((await api('POST', `/api/ai/drafts/${d3.data.id}/mark`, { status: 'discarded' }, sup.token)).data.status, 'discarded');

    // usage is an owner view
    assert.equal((await api('GET', '/api/ai/usage', undefined, sup.token)).status, 403);
    const u = await api('GET', '/api/ai/usage', undefined, adminToken);
    assert.equal(u.status, 200);
    assert.ok(u.data.drafts >= 3 && u.data.sent >= 2 && u.data.sent_unedited >= 1 && u.data.discarded >= 1);
    assert.equal(u.data.provider, 'heuristic');

    // per-person hourly limit
    process.env.AI_DRAFTS_PER_HOUR = '2';
    const lim = await makeStaff('support', 'ai-limit@test.local');
    assert.equal((await api('POST', '/api/ai/drafts', { thread_id: csThread }, lim.token)).status, 201);
    assert.equal((await api('POST', '/api/ai/drafts', { thread_id: csThread }, lim.token)).status, 201);
    assert.equal((await api('POST', '/api/ai/drafts', { thread_id: csThread }, lim.token)).status, 429);
  } finally {
    for (const [k, v] of [['OPENAI_API_KEY', keep.k], ['AI_ENABLED', keep.e], ['AI_DRAFTS_PER_HOUR', keep.l]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('REGRESSION: dispute drafts only see the channel they reply to; the provider request leaks no contact details', async () => {
  const keep = { k: process.env.OPENAI_API_KEY, e: process.env.AI_ENABLED };
  const realFetch = global.fetch;
  let captured = null;
  try {
    const pid = await activeProject();
    const desc = 'The grout is cracking already. Call me at 707-555-0123 about it.';
    const dsp = await api('POST', '/api/disputes', { project_id: pid, reason: 'quality', description: desc }, custToken);
    assert.equal(dsp.status, 201);
    const did = dsp.data.id;
    const sup = await makeStaff('support', 'ai-disp@test.local');
    await api('POST', `/api/disputes/${did}/comments`, { body: 'CONTRACTOR-CHANNEL-SECRET: the wall was not level', visibility: 'contractor' }, sup.token);
    await api('POST', `/api/disputes/${did}/comments`, { body: 'CUSTOMER-CHANNEL-NOTE: we are reviewing your photos', visibility: 'customer' }, sup.token);
    await api('POST', `/api/disputes/${did}/comments`, { body: 'Here are more details from me.' }, custToken);
    await api('POST', `/api/disputes/${did}/comments`, { body: 'CONTRACTOR-STATEMENT: I followed the plan.' }, contToken);

    // provider ON, but only our fake answers (everything else still reaches the real test server)
    process.env.OPENAI_API_KEY = 'sk-test'; process.env.AI_ENABLED = 'true';
    global.fetch = async (url, opts) => {
      if (String(url).startsWith('https://api.openai.com')) {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'Thanks for the details. We are reviewing it and will update you here. Reach us at help@evil.test' } }], usage: { prompt_tokens: 111, completion_tokens: 22 } }) };
      }
      return realFetch(url, opts);
    };
    const toCust = await api('POST', '/api/ai/drafts', { dispute_id: did, audience: 'customer' }, sup.token);
    assert.equal(toCust.status, 201);
    assert.equal(toCust.data.provider, 'openai');
    const sentUser = captured.messages[1].content;
    assert.match(sentUser, /grout is cracking/, 'their own complaint is the context');
    assert.match(sentUser, /CUSTOMER-CHANNEL-NOTE/);
    assert.ok(!/CONTRACTOR-CHANNEL-SECRET|CONTRACTOR-STATEMENT/.test(sentUser), 'the contractor side never reaches a customer draft');
    assert.ok(!/707-555-0123/.test(JSON.stringify(captured)), 'phone numbers never leave the server');
    assert.match(captured.messages[0].content, /untrusted/);
    assert.ok(!/help@evil/.test(toCust.data.body), 'contact details in the model output are stripped');
    assert.ok(toCust.data.flags.includes('removed_contact_details'));

    const toCont = await api('POST', '/api/ai/drafts', { dispute_id: did, audience: 'contractor' }, sup.token);
    const contUser = captured.messages[1].content;
    assert.match(contUser, /CONTRACTOR-CHANNEL-SECRET/);
    assert.match(contUser, /CONTRACTOR-STATEMENT/);
    assert.ok(!/grout is cracking|CUSTOMER-CHANNEL-NOTE|more details from me/.test(contUser), 'the customer side never reaches a contractor draft');
    assert.equal(toCont.data.audience, 'contractor');
    const usage = await api('GET', '/api/ai/usage', undefined, adminToken);
    assert.ok(usage.data.tokens.prompt >= 222 && usage.data.by_provider.openai >= 2, 'tokens and provider are tracked');

    // provider outage: falls back to the template and says so
    global.fetch = async (url, opts) => (String(url).startsWith('https://api.openai.com') ? { ok: false, status: 503, json: async () => ({}) } : realFetch(url, opts));
    const down = await api('POST', '/api/ai/drafts', { dispute_id: did, audience: 'customer' }, sup.token);
    assert.equal(down.status, 201);
    assert.equal(down.data.provider, 'heuristic');
    assert.ok(down.data.flags.includes('ai_unavailable_used_template'));

    // closed disputes get no drafts
    const fin = await makeStaff('finance', 'ai-closer@test.local');
    await api('POST', `/api/disputes/${did}/resolve`, { resolution: 'no_action', notes: 'The work is fine.' }, fin.token);
    assert.equal((await api('POST', '/api/ai/drafts', { dispute_id: did, audience: 'customer' }, sup.token)).status, 409);
  } finally {
    global.fetch = realFetch;
    for (const [k, v] of [['OPENAI_API_KEY', keep.k], ['AI_ENABLED', keep.e]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('REGRESSION: case summary is built from the database (no AI) and respects who may see costs', async () => {
  const pid = await activeProject();
  await api('POST', '/api/disputes', { project_id: pid, reason: 'incomplete', description: 'Half of the work is still missing.' }, custToken);
  const sup = await makeStaff('support', 'sum-sup@test.local');
  const dis = await makeStaff('dispatch', 'sum-dis@test.local');
  const s = await api('POST', '/api/ai/summary', { project_id: pid }, sup.token);
  assert.equal(s.status, 200);
  assert.match(s.data.generated, /no AI/);
  assert.match(s.data.text, /stage: in progress/);
  assert.match(s.data.text, /OPEN DISPUTE/);
  assert.match(s.data.text, /Milestones: 0 of \d+ approved/);
  assert.ok(!/Contractor budget/.test(s.data.text), 'support does not see what the contractor is paid');
  assert.match((await api('POST', '/api/ai/summary', { project_id: pid }, dis.token)).data.text, /Contractor budget: \$300\.00/);
  assert.equal((await api('POST', '/api/ai/summary', { project_id: pid }, custToken)).status, 403);
  assert.equal((await api('POST', '/api/ai/summary', {}, sup.token)).status, 422);
  assert.equal((await api('POST', '/api/ai/summary', { project_id: 999999 }, sup.token)).status, 404);
});

after(async () => {
  // The server keeps the process alive, so exit explicitly — but give the reporter a moment first:
  // exiting immediately dropped the result of the LAST test from the report.
  await new Promise((r) => setTimeout(r, 500));
  process.exit(0);
});
