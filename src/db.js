// Database layer: SQLite (better-sqlite3) by default, PostgreSQL when
// DATABASE_URL is set. Both expose the same async-compatible API:
//   await db.prepare(sql).get(...params) -> row | undefined
//   await db.prepare(sql).all(...params) -> rows[]
//   await db.prepare(sql).run(...params) -> { lastInsertRowid, changes }
//   await db.exec(sql)
//   await db.transaction(async (t) => { ... })
//
// Money is stored in integer CENTS everywhere to avoid float errors.
if (process.env.DATABASE_URL) {
  module.exports = require('./db/pg');
  return;
}

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'handyman.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('customer','contractor','admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contractors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  legal_name TEXT NOT NULL,
  city TEXT,
  service_base TEXT,
  service_radius_miles INTEGER DEFAULT 25,
  years_experience INTEGER DEFAULT 0,
  specialties TEXT,
  license_number TEXT,
  insurance_info TEXT,
  license_verified INTEGER NOT NULL DEFAULT 0,
  insurance_verified INTEGER NOT NULL DEFAULT 0,
  background_check TEXT NOT NULL DEFAULT 'pending' CHECK (background_check IN ('pending','passed','failed')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended')),
  has_license INTEGER NOT NULL DEFAULT 1,
  license_exempt INTEGER NOT NULL DEFAULT 0,
  contractor_kind TEXT NOT NULL DEFAULT 'independent' CHECK (contractor_kind IN ('independent','inhouse')),
  rating_avg REAL DEFAULT 0,
  jobs_completed INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  address TEXT NOT NULL,
  city TEXT,
  state TEXT,
  zip TEXT,
  service_type TEXT NOT NULL,
  urgency TEXT NOT NULL DEFAULT 'standard' CHECK (urgency IN ('standard','urgent')),
  description TEXT NOT NULL,
  scope_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','ai_analyzed','quote_sent','deposit_paid','assigned','scheduled','in_progress','review','completed','lost','cancelled')),
  lead_score INTEGER NOT NULL DEFAULT 0,
  source TEXT DEFAULT 'web',
  claim_token TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_request_id INTEGER REFERENCES job_requests(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  original_name TEXT,
  mime TEXT,
  size_bytes INTEGER,
  width INTEGER,
  height INTEGER,
  kind TEXT NOT NULL DEFAULT 'request' CHECK (kind IN ('request','progress','completion','signoff')),
  vision_json TEXT DEFAULT '{}',
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS estimates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_request_id INTEGER NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
  low_cents INTEGER NOT NULL,
  high_cents INTEGER NOT NULL,
  line_items_json TEXT NOT NULL DEFAULT '[]',
  missing_json TEXT NOT NULL DEFAULT '[]',
  risks_json TEXT NOT NULL DEFAULT '[]',
  confidence INTEGER NOT NULL DEFAULT 0,
  factors_json TEXT NOT NULL DEFAULT '[]',
  engine_version TEXT NOT NULL DEFAULT '1.0',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_request_id INTEGER NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
  estimate_id INTEGER REFERENCES estimates(id) ON DELETE SET NULL,
  customer_price_cents INTEGER NOT NULL,
  contractor_cost_cents INTEGER NOT NULL,
  deposit_cents INTEGER NOT NULL,
  deposit_pct INTEGER NOT NULL DEFAULT 30,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','rejected','expired')),
  valid_until TEXT,
  sent_at TEXT,
  responded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_request_id INTEGER NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
  quote_id INTEGER REFERENCES quotes(id) ON DELETE SET NULL,
  contractor_id INTEGER REFERENCES contractors(id) ON DELETE SET NULL,
  stage TEXT NOT NULL DEFAULT 'assigned' CHECK (stage IN ('assigned','scheduled','in_progress','review','completed','cancelled')),
  scheduled_start TEXT,
  scheduled_end TEXT,
  customer_price_cents INTEGER NOT NULL,
  contractor_cost_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed')),
  customer_approval TEXT NOT NULL DEFAULT 'pending' CHECK (customer_approval IN ('pending','approved','rejected')),
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Bookkeeping only. Stripe is NOT integrated (see ROADMAP.md).
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('deposit','milestone','final','refund')),
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','pending','failed')),
  provider TEXT NOT NULL DEFAULT 'manual' CHECK (provider IN ('manual','stripe_stub')),
  provider_ref TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS email_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  segment TEXT NOT NULL,
  template_id INTEGER REFERENCES email_templates(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','queued','sending','done')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS email_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
  to_email TEXT NOT NULL,
  to_name TEXT,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed')),
  provider TEXT NOT NULL DEFAULT 'console',
  error TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outbox_id INTEGER REFERENCES email_outbox(id) ON DELETE SET NULL,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contractor_id INTEGER REFERENCES contractors(id) ON DELETE SET NULL,
  customer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  referrer_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  referred_email TEXT,
  referred_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','redeemed')),
  discount_pct INTEGER NOT NULL DEFAULT 10,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  redeemed_at TEXT
);

CREATE TABLE IF NOT EXISTS followup_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_request_id INTEGER REFERENCES job_requests(id) ON DELETE CASCADE,
  quote_id INTEGER REFERENCES quotes(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_request_id INTEGER NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON job_requests(status);
CREATE INDEX IF NOT EXISTS idx_jobs_email ON job_requests(email);
CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);
CREATE INDEX IF NOT EXISTS idx_projects_stage ON projects(stage);
CREATE INDEX IF NOT EXISTS idx_projects_contractor ON projects(contractor_id);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON email_outbox(status);

-- PRO 100%: mediated messaging (client<->support, support<->contractor).
-- Direct client<->contractor contact is PROHIBITED by business rule: the
-- platform owns the customer relationship. Two thread kinds per project.
CREATE TABLE IF NOT EXISTS message_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('client_support','support_contractor')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, kind)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
  sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('customer','contractor','admin')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_threads_project ON message_threads(project_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);

-- PRO 100%: admin audit trail.
CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_admin ON admin_audit(admin_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON admin_audit(entity, entity_id);

-- Legal: append-only log of Terms acceptances (client quote acceptance,
-- contractor job acceptance). This is the legal proof of who accepted what
-- version and when. Rows are never updated or deleted by the app.
CREATE TABLE IF NOT EXISTS terms_acceptances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('client_quote','contractor_job')),
  reference_id INTEGER NOT NULL,
  terms_version TEXT NOT NULL,
  accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
  ip TEXT,
  UNIQUE (kind, reference_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_terms_user ON terms_acceptances(user_id);
CREATE INDEX IF NOT EXISTS idx_terms_ref ON terms_acceptances(kind, reference_id);

CREATE TABLE IF NOT EXISTS ai_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,provider TEXT NOT NULL,model TEXT,
  job_request_id INTEGER REFERENCES job_requests(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  input_summary TEXT,output_json TEXT NOT NULL DEFAULT '{}',confidence INTEGER,
  status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('completed','fallback','failed')),
  error_code TEXT,duration_ms INTEGER,created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_runs_job ON ai_runs(job_request_id);
CREATE INDEX IF NOT EXISTS idx_ai_runs_project ON ai_runs(project_id);

CREATE TABLE IF NOT EXISTS job_scope_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_request_id INTEGER NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,source TEXT NOT NULL CHECK(source IN ('customer','ai','admin','contractor')),
  scope_json TEXT NOT NULL,confidence INTEGER,created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT(datetime('now')),UNIQUE(job_request_id,version_no)
);
CREATE TABLE IF NOT EXISTS risk_assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_request_id INTEGER NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
  severity TEXT NOT NULL DEFAULT 'low' CHECK(severity IN ('low','medium','high','critical')),
  flags_json TEXT NOT NULL DEFAULT '[]',requires_human_review INTEGER NOT NULL DEFAULT 0,
  requires_license_review INTEGER NOT NULL DEFAULT 0,requires_permit_review INTEGER NOT NULL DEFAULT 0,
  notes TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE TABLE IF NOT EXISTS user_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL UNIQUE,token_hash TEXT NOT NULL,user_agent TEXT,ip_prefix TEXT,
  expires_at TEXT NOT NULL,revoked_at TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now')),last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);

CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info','warning','critical')),
  ip_prefix TEXT,user_agent TEXT,detail TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(event_type);


CREATE TABLE IF NOT EXISTS operations_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,detail TEXT,entity_type TEXT,entity_id INTEGER,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','blocked','done','dismissed')),
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,due_at TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','system','sla','payment','dispatch','compliance','customer')),
  fingerprint TEXT,created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  completed_at TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ops_tasks_status_priority ON operations_tasks(status,priority);
CREATE INDEX IF NOT EXISTS idx_ops_tasks_assignee ON operations_tasks(assigned_to);

CREATE TABLE IF NOT EXISTS operations_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,entity_id INTEGER NOT NULL,body TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'internal' CHECK(visibility IN ('internal')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ops_notes_entity ON operations_notes(entity_type,entity_id);

CREATE TABLE IF NOT EXISTS sla_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,code TEXT NOT NULL UNIQUE,label TEXT NOT NULL,
  threshold_minutes INTEGER NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
INSERT OR IGNORE INTO sla_policies(code,label,threshold_minutes,enabled) VALUES
 ('new_lead_first_action','New lead first action',60,1),
 ('quote_response_followup','Quote follow-up',2880,1),
 ('unassigned_project','Accepted project assignment',240,1),
 ('contractor_offer_response','Contractor offer response',120,1),
 ('customer_approval_wait','Customer approval wait',2880,1),
 ('payment_failure','Payment failure attention',30,1);

CREATE TABLE IF NOT EXISTS operations_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,event_type TEXT NOT NULL,entity_type TEXT,entity_id INTEGER,
  severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info','warning','critical')),
  summary TEXT NOT NULL,detail TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ops_events_created ON operations_events(created_at);
CREATE TABLE IF NOT EXISTS dispatch_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  match_score REAL,
  status TEXT NOT NULL DEFAULT 'offered' CHECK(status IN ('offered','accepted','declined','expired','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dispatch_assignments_project ON dispatch_assignments(project_id);



CREATE TABLE IF NOT EXISTS contractor_skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  skill_code TEXT NOT NULL,
  proficiency TEXT NOT NULL DEFAULT 'experienced' CHECK (proficiency IN ('basic','experienced','expert')),
  years_experience INTEGER NOT NULL DEFAULT 0,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(contractor_id,skill_code)
);
CREATE TABLE IF NOT EXISTS contractor_availability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TEXT,end_time TEXT,is_available INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(contractor_id,weekday)
);
CREATE TABLE IF NOT EXISTS contractor_blackouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,end_date TEXT NOT NULL,reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS contractor_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL,label TEXT,document_number TEXT,issuer TEXT,expires_on TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','verified','rejected','expired')),
  storage_key TEXT,original_name TEXT,mime TEXT,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,reviewed_at TEXT,rejection_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS contractor_daily_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  work_date TEXT NOT NULL,summary TEXT NOT NULL,hours_worked REAL,blockers TEXT,
  customer_visible INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS contractor_offer_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('offered','viewed','accepted','declined','expired')),
  detail TEXT,created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS contractor_quality_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,points INTEGER NOT NULL DEFAULT 0,note TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS contractor_payables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  payable_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','paid','cancelled')),
  due_at TEXT,paid_at TEXT,created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contractor_skills_contractor ON contractor_skills(contractor_id);
CREATE INDEX IF NOT EXISTS idx_contractor_documents_contractor ON contractor_documents(contractor_id);
CREATE INDEX IF NOT EXISTS idx_contractor_offer_events ON contractor_offer_events(contractor_id,project_id);
CREATE INDEX IF NOT EXISTS idx_payables_contractor ON contractor_payables(contractor_id);


CREATE TABLE IF NOT EXISTS change_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  reason TEXT,
  price_delta_cents INTEGER NOT NULL DEFAULT 0,
  schedule_delta_days INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','approved','rejected','cancelled')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sent_at TEXT,
  responded_at TEXT,
  customer_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_change_orders_project ON change_orders(project_id);
CREATE INDEX IF NOT EXISTS idx_change_orders_status ON change_orders(status);

CREATE TABLE IF NOT EXISTS project_schedule_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  preferred_date TEXT,
  time_window TEXT CHECK (time_window IN ('morning','afternoon','evening','anytime')),
  flexibility TEXT CHECK (flexibility IN ('exact','plus_minus_1','plus_minus_3','flexible')),
  notes TEXT,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_customer_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  actor_role TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_customer_events_project ON project_customer_events(project_id);

`;

db.exec(SCHEMA);

// ---- Lightweight migrations for pre-existing databases ----
function columnExists(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
}
if (!columnExists('users', 'email_verified')) {
  db.exec(`ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0`);
}
if (!columnExists('users', 'verify_token')) {
  db.exec(`ALTER TABLE users ADD COLUMN verify_token TEXT`);
}
if (!columnExists('users', 'verify_expires')) {
  db.exec(`ALTER TABLE users ADD COLUMN verify_expires TEXT`);
}
if (!columnExists('users', 'reset_token')) {
  db.exec(`ALTER TABLE users ADD COLUMN reset_token TEXT`);
}
if (!columnExists('users', 'reset_expires')) {
  db.exec(`ALTER TABLE users ADD COLUMN reset_expires TEXT`);
}
if (!columnExists('projects', 'contractor_status')) {
  db.exec(`ALTER TABLE projects ADD COLUMN contractor_status TEXT CHECK (contractor_status IN ('offered','accepted','declined'))`);
}
// ---- 2026-10-07: contractor licensing + kind (independent vs in-house) ----
if (!columnExists('contractors', 'has_license')) {
  db.exec(`ALTER TABLE contractors ADD COLUMN has_license INTEGER NOT NULL DEFAULT 1`);
}
if (!columnExists('contractors', 'license_exempt')) {
  db.exec(`ALTER TABLE contractors ADD COLUMN license_exempt INTEGER NOT NULL DEFAULT 0`);
}
if (!columnExists('contractors', 'contractor_kind')) {
  db.exec(`ALTER TABLE contractors ADD COLUMN contractor_kind TEXT NOT NULL DEFAULT 'independent'`);
}
// ---- 2026-10-07: negotiation offers (contractor counter-offers, CaliFix-style) ----
db.exec(`CREATE TABLE IF NOT EXISTS contractor_offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  proposed_cents INTEGER NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','superseded')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
// ---- 2026-10-07: photos.kind CHECK gains 'signoff' (signed close-out sheet) ----
try {
  const psql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='photos'`).get();
  if (psql && psql.sql && !psql.sql.includes("'signoff'")) {
    db.exec(`
      CREATE TABLE photos_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_request_id INTEGER REFERENCES job_requests(id) ON DELETE CASCADE,
        project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        original_name TEXT,
        mime TEXT,
        size_bytes INTEGER,
        width INTEGER,
        height INTEGER,
        kind TEXT NOT NULL DEFAULT 'request' CHECK (kind IN ('request','progress','completion','signoff')),
        vision_json TEXT DEFAULT '{}',
        uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        storage_key TEXT,
        storage_provider TEXT NOT NULL DEFAULT 'local',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO photos_new (id, job_request_id, project_id, filename, original_name, mime, size_bytes, width, height, kind, vision_json, uploaded_by, storage_key, storage_provider, created_at)
        SELECT id, job_request_id, project_id, filename, original_name, mime, size_bytes, width, height, kind, vision_json, uploaded_by, storage_key, storage_provider, created_at
        FROM photos;
      DROP TABLE photos;
      ALTER TABLE photos_new RENAME TO photos;
    `);
    console.log('[migrate] photos table: kind CHECK now includes signoff');
  }
} catch (e) {
  console.error('[migrate] photos table migration failed:', e.message);
}
if (!columnExists('photos', 'storage_key')) {
  db.exec(`ALTER TABLE photos ADD COLUMN storage_key TEXT`);
}
if (!columnExists('photos', 'storage_provider')) {
  db.exec(`ALTER TABLE photos ADD COLUMN storage_provider TEXT NOT NULL DEFAULT 'local'`);
}

// ---- Migrate payments.provider CHECK to include 'stripe' (was manual/stripe_stub) ----
// Also adds 'paid' to the status CHECK for Stripe-confirmed payments.
// 2026-10-07: also adds 'simulated' provider for the test payment mode.
try {
  const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='payments'`).get();
  if (sql && sql.sql && (!sql.sql.includes("'stripe'") || !sql.sql.includes("'simulated'"))) {
    db.exec(`
      CREATE TABLE payments_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('deposit','milestone','final','refund')),
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','pending','paid','failed')),
        provider TEXT NOT NULL DEFAULT 'manual' CHECK (provider IN ('manual','stripe','simulated')),
        provider_ref TEXT,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO payments_new (id, project_id, kind, amount_cents, status, provider, provider_ref, notes, created_at)
        SELECT id, project_id, kind, amount_cents, status,
               CASE WHEN provider = 'stripe_stub' THEN 'manual' ELSE provider END,
               provider_ref, notes, created_at
        FROM payments;
      DROP TABLE payments;
      ALTER TABLE payments_new RENAME TO payments;
    `);
    console.log('[migrate] payments table: provider CHECK now includes stripe, status includes paid');
  }
} catch (e) {
  console.error('[migrate] payments table migration failed:', e.message);
}

module.exports = db;

// ---- Async-compatible API (mirrors src/db/pg.js) ----
// New pattern: await db.transaction(async (t) => { await t.prepare(...).run(...); })
// On SQLite this is best-effort (no multi-statement atomicity); on PostgreSQL
// it is a real transaction.
{
  const asyncDb = {
    _isPg: false,
    prepare: (sql) => {
      const stmt = db.prepare(sql);
      return {
        get: async (...p) => stmt.get(...p),
        all: async (...p) => stmt.all(...p),
        run: async (...p) => stmt.run(...p),
      };
    },
    exec: async (sql) => db.exec(sql),
  };
  db.transaction = (fn) => fn(asyncDb);
}
