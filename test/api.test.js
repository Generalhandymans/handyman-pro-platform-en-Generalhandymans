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

const db = require('../src/db');
// Pre-insert admin so server.js does NOT auto-seed demo data.
db.prepare(
  "INSERT INTO users (name, email, phone, password_hash, role, email_verified) VALUES (?,?,?,?,?,1)"
).run('Test Admin', 'admin@test.local', '555-000-0001', bcrypt.hashSync('Admin123!', 10), 'admin');

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
const emailLogCount = () => db.prepare('SELECT COUNT(*) c FROM email_log').get().c;

let adminToken, custToken, contToken, adminId, custId, contUserId, contractorId, jobId, quoteId, projectId, csThread, scThread;

before(async () => {
  // wait for server
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 100));
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
  const row = db.prepare("SELECT * FROM email_log WHERE to_email='cust@test.local' AND subject LIKE '%Verify%'").get();
  assert.ok(row, 'verification email logged');
});

test('email verification flow', async () => {
  const u = db.prepare('SELECT verify_token FROM users WHERE email=?').get('cust@test.local');
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
  const u = db.prepare('SELECT reset_token, reset_expires FROM users WHERE email=?').get('cust@test.local');
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
  const photo = db.prepare('SELECT width, height, size_bytes FROM photos WHERE job_request_id=?').get(jobId);
  assert.ok(photo.width <= 1600 && photo.height <= 1600, `resized to ${photo.width}x${photo.height}`);
  assert.ok(photo.size_bytes < buf.length, 'compressed smaller than original');

  const e = await api('POST', `/api/jobs/${jobId}/estimate`, { scope: { sqft: 400 } }, custToken);
  assert.equal(e.status, 201);
  assert.ok(e.data.low_cents > 0 && e.data.high_cents >= e.data.low_cents);
});

test('quote create → send (customer notified) → accept requires terms (admin notified, project born)', async () => {
  const before = emailLogCount();
  const q = await api('POST', '/api/quotes', {
    job_request_id: jobId, customer_price_cents: 120000, contractor_cost_cents: 80000, deposit_pct: 30,
  }, adminToken);
  assert.equal(q.status, 201);
  quoteId = q.data.id;

  const s = await api('POST', `/api/quotes/${quoteId}/send`, {}, adminToken);
  assert.equal(s.status, 200);
  assert.equal(s.data.status, 'sent');

  // customer got the "quote ready" email (logged)
  const n1 = db.prepare("SELECT * FROM email_log WHERE to_email='cust@test.local' AND subject LIKE '%quote%ready%' ORDER BY id DESC").get();
  assert.ok(n1, 'quote-ready notification logged');

  // Legal gate: accepting without terms_accepted is rejected.
  const noTerms = await api('POST', `/api/quotes/${quoteId}/respond`, { accept: true }, custToken);
  assert.equal(noTerms.status, 400);
  assert.match(noTerms.data.error, /Terms of Service/);
  const stillSent = db.prepare('SELECT status FROM quotes WHERE id=?').get(quoteId);
  assert.equal(stillSent.status, 'sent');

  const r = await api('POST', `/api/quotes/${quoteId}/respond`, { accept: true, terms_accepted: true }, custToken);
  assert.equal(r.status, 200);
  assert.equal(r.data.accepted, true);
  projectId = r.data.project_id;
  assert.ok(projectId);

  // Legal proof recorded: who accepted which terms version, when.
  const acc = db.prepare(
    "SELECT * FROM terms_acceptances WHERE kind='client_quote' AND reference_id=? AND user_id=?"
  ).get(quoteId, custId);
  assert.ok(acc, 'client terms acceptance recorded');
  assert.ok(acc.terms_version, 'terms version recorded');
  assert.ok(acc.accepted_at, 'acceptance timestamp recorded');

  // admins got the "quote accepted" email
  const n2 = db.prepare("SELECT * FROM email_log WHERE to_email='admin@test.local' AND subject LIKE '%accepted%' ORDER BY id DESC").get();
  assert.ok(n2, 'quote-accepted notification logged');

  assert.ok(emailLogCount() > before, 'notifications were logged');
});

test('contractor offer → accept requires terms; decline releases the project', async () => {
  const c = db.prepare('SELECT id FROM contractors WHERE user_id=?').get(contUserId);
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

  const n1 = db.prepare("SELECT * FROM email_log WHERE to_email='cont@test.local' AND subject LIKE '%offer%' ORDER BY id DESC").get();
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
  const acc = db.prepare(
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
  const released = db.prepare('SELECT contractor_id, contractor_status FROM projects WHERE id=?').get(p2);
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
  const n = db.prepare("SELECT * FROM email_log WHERE to_email='cust@test.local' AND subject LIKE '%New message%' ORDER BY id DESC").get();
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
  const n1 = db.prepare("SELECT * FROM email_log WHERE to_email='cust@test.local' AND subject LIKE '%Milestone done%' ORDER BY id DESC").get();
  assert.ok(n1, 'milestone-done notification logged');

  const a1 = await api('POST', `/api/projects/${projectId}/milestones/${mid}/approve`, { approved: true }, custToken);
  assert.equal(a1.status, 200);
  const n2 = db.prepare("SELECT * FROM email_log WHERE to_email='cont@test.local' AND subject LIKE '%Milestone approved%' ORDER BY id DESC").get();
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
  const pay = db.prepare("SELECT * FROM payments WHERE project_id=? AND kind='deposit'").get(projectId);
  assert.ok(pay, 'manual deposit record exists');
  assert.equal(pay.provider, 'manual');
  assert.equal(pay.status, 'recorded');
});

test('rate limiting headers present on auth endpoints', async () => {
  const r = await api('POST', '/api/auth/login', { email: 'admin@test.local', password: 'wrong' });
  assert.equal(r.status, 401);
  const rl = r.headers.get('ratelimit'); // draft-7 combined header
  assert.ok(rl && rl.includes('limit=20'), 'rate-limit headers present');
});

test('project completion notifies customer', async () => {
  const s = await api('PATCH', `/api/projects/${projectId}/stage`, { stage: 'completed' }, adminToken);
  assert.equal(s.status, 200);
  const n = db.prepare("SELECT * FROM email_log WHERE to_email='cust@test.local' AND subject LIKE '%complete%' ORDER BY id DESC").get();
  assert.ok(n, 'project-completed notification logged');
});

test('contractor recommendations: admin gets ranked matches, others refused', async () => {
  // Make the test contractor fully verified + active so matching can rank them.
  db.prepare(`UPDATE contractors SET status='active', license_verified=1, insurance_verified=1, background_check='passed', specialties='["painting"]', rating_avg=4.5 WHERE id=?`).run(contractorId);
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

after(async () => {
  // leave the server running for manual QA; tests used an isolated DB file.
  process.exit(0);
});
