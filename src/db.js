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
  photo_filename TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended')),
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
  kind TEXT NOT NULL DEFAULT 'request' CHECK (kind IN ('request','progress','completion')),
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
  offer_expires_at TEXT,
  arrival_window TEXT,
  schedule_status TEXT NOT NULL DEFAULT 'pending',
  schedule_token TEXT,
  schedule_expires_at TEXT,
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
if (!columnExists('photos', 'storage_key')) {
  db.exec(`ALTER TABLE photos ADD COLUMN storage_key TEXT`);
}
if (!columnExists('photos', 'storage_provider')) {
  db.exec(`ALTER TABLE photos ADD COLUMN storage_provider TEXT NOT NULL DEFAULT 'local'`);
}

// ---- Hardening migrations (mirrored for PostgreSQL in src/db/migrations/002_hardening.sql) ----
if (!columnExists('users', 'token_version')) {
  db.exec(`ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0`);
}
db.exec(`CREATE TABLE IF NOT EXISTS ai_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('message_reply','dispute_reply')),
  thread_id INTEGER REFERENCES message_threads(id) ON DELETE SET NULL,
  dispute_id INTEGER REFERENCES disputes(id) ON DELETE SET NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  audience TEXT NOT NULL CHECK (audience IN ('customer','contractor')),
  provider TEXT NOT NULL,
  model TEXT,
  body TEXT NOT NULL,
  flags TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','discarded')),
  final_body TEXT,
  edited INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
if (!columnExists('projects', 'reminder_sent_at')) {
  db.exec(`ALTER TABLE projects ADD COLUMN reminder_sent_at TEXT`);
}
db.exec(`CREATE TABLE IF NOT EXISTS sms_consents (
  phone TEXT PRIMARY KEY,
  opted_in INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
db.exec(`CREATE TABLE IF NOT EXISTS sms_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_phone TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  provider TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
db.exec(`CREATE TABLE IF NOT EXISTS visit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('completed','customer_no_show','contractor_no_show','rescheduled')),
  by_user INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
if (!columnExists('users', 'totp_enabled')) {
  db.exec(`ALTER TABLE users ADD COLUMN totp_secret TEXT`);
  db.exec(`ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0`);
  db.exec(`ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0`);
  db.exec(`ALTER TABLE users ADD COLUMN totp_recovery TEXT`);
}
if (!columnExists('users', 'staff_role')) {
  db.exec(`ALTER TABLE users ADD COLUMN staff_role TEXT`);
}
if (!columnExists('messages', 'flagged')) {
  db.exec(`ALTER TABLE messages ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0`);
}
if (!columnExists('messages', 'flag_reason')) {
  db.exec(`ALTER TABLE messages ADD COLUMN flag_reason TEXT`);
}
if (!columnExists('job_requests', 'lat')) {
  db.exec(`ALTER TABLE job_requests ADD COLUMN lat REAL`);
  db.exec(`ALTER TABLE job_requests ADD COLUMN lng REAL`);
}
if (!columnExists('contractors', 'lat')) {
  db.exec(`ALTER TABLE contractors ADD COLUMN lat REAL`);
  db.exec(`ALTER TABLE contractors ADD COLUMN lng REAL`);
}
db.exec(`CREATE TABLE IF NOT EXISTS email_suppressions (
  email TEXT PRIMARY KEY,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

// Completion sheet: the customer's signed acceptance of finished work.
db.exec(`CREATE TABLE IF NOT EXISTS completion_sheets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  signer_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  signer_name TEXT NOT NULL,
  signature_png TEXT NOT NULL,
  checklist_json TEXT,
  notes TEXT,
  ip TEXT,
  signed_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

// Money owed to contractors: one payable per completed project.
db.exec(`CREATE TABLE IF NOT EXISTS contractor_payables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  payable_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','paid','cancelled')),
  due_at TEXT,
  paid_at TEXT,
  paid_method TEXT,
  paid_reference TEXT,
  paid_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

// Disputes: a formal channel for "this work is not right" (customer) or "the customer will not
// approve" (contractor). One open dispute per project, enforced by the partial unique index.
db.exec(`CREATE TABLE IF NOT EXISTS disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  opened_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  opened_by_role TEXT NOT NULL CHECK (opened_by_role IN ('customer','contractor')),
  reason TEXT NOT NULL CHECK (reason IN ('quality','incomplete','no_show','damage','billing','other')),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved','withdrawn')),
  resolution TEXT CHECK (resolution IS NULL OR resolution IN ('no_action','rework','partial_refund','full_refund')),
  resolution_notes TEXT,
  refund_cents INTEGER NOT NULL DEFAULT 0,
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_dispute_open_per_project ON disputes(project_id) WHERE status IN ('open','investigating')`);
db.exec(`CREATE TABLE IF NOT EXISTS dispute_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispute_id INTEGER NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author_role TEXT NOT NULL CHECK (author_role IN ('customer','contractor','admin')),
  visibility TEXT NOT NULL CHECK (visibility IN ('customer','contractor','staff')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

// ---- Migrate payments.provider CHECK to include 'stripe' (was manual/stripe_stub) ----
// Also adds 'paid' to the status CHECK for Stripe-confirmed payments.
try {
  const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='payments'`).get();
  if (sql && sql.sql && !sql.sql.includes("'stripe'")) {
    db.exec(`
      CREATE TABLE payments_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('deposit','milestone','final','refund')),
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','pending','paid','failed')),
        provider TEXT NOT NULL DEFAULT 'manual' CHECK (provider IN ('manual','stripe')),
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
  // Real transaction: BEGIN IMMEDIATE / COMMIT / ROLLBACK, one at a time.
  // LIMIT (single SQLite connection): a write from ANOTHER request that lands
  // while a transaction is awaiting joins that transaction. That is acceptable
  // for tests and low traffic; production must use PostgreSQL (DATABASE_URL),
  // where every transaction owns its own connection.
  let txChain = Promise.resolve();
  db.transaction = (fn) => {
    const run = txChain.then(async () => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(asyncDb);
        db.exec('COMMIT');
        return result;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
        throw e;
      }
    });
    txChain = run.catch(() => {});
    return run;
  };
}
