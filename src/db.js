// Database layer: single SQLite file via better-sqlite3.
// Money is stored in integer CENTS everywhere to avoid float errors.
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
if (!columnExists('users', 'reset_token')) {
  db.exec(`ALTER TABLE users ADD COLUMN reset_token TEXT`);
}
if (!columnExists('users', 'reset_expires')) {
  db.exec(`ALTER TABLE users ADD COLUMN reset_expires TEXT`);
}

module.exports = db;
