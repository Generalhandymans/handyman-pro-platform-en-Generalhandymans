-- General Handyman Solutions — PostgreSQL production schema.
--
-- This is a faithful translation of the CURRENT SQLite schema (src/db.js,
-- including all lightweight migrations) so every existing query keeps working.
-- Integer flag columns (email_verified, license_verified, ...) stay INTEGER
-- on purpose: app code compares them with `= 1`.
--
-- Plus the non-conflicting new V2 tables: media_objects, stripe_events,
-- contractor_payables, dispatch_assignments, ai_recommendations.
--
-- Run: psql "$DATABASE_URL" -f 001_initial.sql

BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('customer','contractor','admin')),
  email_verified INTEGER NOT NULL DEFAULT 0,
  verify_token TEXT,
  verify_expires TEXT,
  reset_token TEXT,
  reset_expires TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contractors (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
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
  rating_avg DOUBLE PRECISION DEFAULT 0,
  jobs_completed INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS job_requests (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS estimates (
  id BIGSERIAL PRIMARY KEY,
  job_request_id BIGINT NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
  low_cents INTEGER NOT NULL,
  high_cents INTEGER NOT NULL,
  line_items_json TEXT NOT NULL DEFAULT '[]',
  missing_json TEXT NOT NULL DEFAULT '[]',
  risks_json TEXT NOT NULL DEFAULT '[]',
  confidence INTEGER NOT NULL DEFAULT 0,
  factors_json TEXT NOT NULL DEFAULT '[]',
  engine_version TEXT NOT NULL DEFAULT '1.0',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quotes (
  id BIGSERIAL PRIMARY KEY,
  job_request_id BIGINT NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
  estimate_id BIGINT REFERENCES estimates(id) ON DELETE SET NULL,
  customer_price_cents INTEGER NOT NULL,
  contractor_cost_cents INTEGER NOT NULL,
  deposit_cents INTEGER NOT NULL,
  deposit_pct INTEGER NOT NULL DEFAULT 30,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','rejected','expired')),
  valid_until TEXT,
  sent_at TEXT,
  responded_at TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
  id BIGSERIAL PRIMARY KEY,
  job_request_id BIGINT NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
  quote_id BIGINT REFERENCES quotes(id) ON DELETE SET NULL,
  contractor_id BIGINT REFERENCES contractors(id) ON DELETE SET NULL,
  contractor_status TEXT CHECK (contractor_status IN ('offered','accepted','declined')),
  stage TEXT NOT NULL DEFAULT 'assigned' CHECK (stage IN ('assigned','scheduled','in_progress','review','completed','cancelled')),
  scheduled_start TEXT,
  scheduled_end TEXT,
  customer_price_cents INTEGER NOT NULL,
  contractor_cost_cents INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS photos (
  id BIGSERIAL PRIMARY KEY,
  job_request_id BIGINT REFERENCES job_requests(id) ON DELETE CASCADE,
  project_id BIGINT REFERENCES projects(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  original_name TEXT,
  mime TEXT,
  size_bytes INTEGER,
  width INTEGER,
  height INTEGER,
  kind TEXT NOT NULL DEFAULT 'request' CHECK (kind IN ('request','progress','completion')),
  vision_json TEXT DEFAULT '{}',
  uploaded_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  storage_key TEXT,
  storage_provider TEXT NOT NULL DEFAULT 'local',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS milestones (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed')),
  customer_approval TEXT NOT NULL DEFAULT 'pending' CHECK (customer_approval IN ('pending','approved','rejected')),
  approved_at TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('deposit','milestone','final','refund')),
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','pending','paid','failed')),
  provider TEXT NOT NULL DEFAULT 'manual' CHECK (provider IN ('manual','stripe')),
  provider_ref TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_templates (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS campaigns (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  segment TEXT NOT NULL,
  template_id BIGINT REFERENCES email_templates(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','queued','sending','done')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_outbox (
  id BIGSERIAL PRIMARY KEY,
  campaign_id BIGINT REFERENCES campaigns(id) ON DELETE CASCADE,
  to_email TEXT NOT NULL,
  to_name TEXT,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed')),
  provider TEXT NOT NULL DEFAULT 'console',
  error TEXT,
  sent_at TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_log (
  id BIGSERIAL PRIMARY KEY,
  outbox_id BIGINT REFERENCES email_outbox(id) ON DELETE SET NULL,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reviews (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contractor_id BIGINT REFERENCES contractors(id) ON DELETE SET NULL,
  customer_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS referrals (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  referrer_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  referred_email TEXT,
  referred_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','redeemed')),
  discount_pct INTEGER NOT NULL DEFAULT 10,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  redeemed_at TEXT
);

CREATE TABLE IF NOT EXISTS followup_tasks (
  id BIGSERIAL PRIMARY KEY,
  job_request_id BIGINT REFERENCES job_requests(id) ON DELETE CASCADE,
  quote_id BIGINT REFERENCES quotes(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS interactions (
  id BIGSERIAL PRIMARY KEY,
  job_request_id BIGINT NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS message_threads (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('client_support','support_contractor')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, kind)
);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  thread_id BIGINT NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
  sender_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('customer','contractor','admin')),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_audit (
  id BIGSERIAL PRIMARY KEY,
  admin_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id BIGINT,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS terms_acceptances (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('client_quote','contractor_job')),
  reference_id BIGINT NOT NULL,
  terms_version TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip TEXT,
  UNIQUE (kind, reference_id, user_id)
);

-- ---- V2 additions (new tables, no conflicts with the app schema) ----

CREATE TABLE IF NOT EXISTS media_objects (
  id BIGSERIAL PRIMARY KEY,
  job_request_id BIGINT REFERENCES job_requests(id) ON DELETE CASCADE,
  project_id BIGINT REFERENCES projects(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL,
  original_name TEXT,
  mime TEXT,
  size_bytes BIGINT,
  kind TEXT NOT NULL DEFAULT 'request' CHECK (kind IN ('request','progress','completion')),
  uploaded_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stripe_events (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contractor_payables (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contractor_id BIGINT NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  payable_cents BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','paid','cancelled')),
  due_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dispatch_assignments (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contractor_id BIGINT NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  match_score DOUBLE PRECISION,
  status TEXT NOT NULL DEFAULT 'offered' CHECK (status IN ('offered','accepted','declined','expired')),
  offered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ai_recommendations (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  explanation TEXT,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
  job_request_id BIGINT REFERENCES job_requests(id) ON DELETE CASCADE,
  project_id BIGINT REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acted','dismissed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---- Indexes (mirroring the SQLite schema) ----
CREATE INDEX IF NOT EXISTS idx_jobs_status ON job_requests(status);
CREATE INDEX IF NOT EXISTS idx_jobs_email ON job_requests(email);
CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);
CREATE INDEX IF NOT EXISTS idx_projects_stage ON projects(stage);
CREATE INDEX IF NOT EXISTS idx_projects_contractor ON projects(contractor_id);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON email_outbox(status);
CREATE INDEX IF NOT EXISTS idx_threads_project ON message_threads(project_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_audit_admin ON admin_audit(admin_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON admin_audit(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_terms_user ON terms_acceptances(user_id);
CREATE INDEX IF NOT EXISTS idx_terms_ref ON terms_acceptances(kind, reference_id);
CREATE INDEX IF NOT EXISTS idx_media_project ON media_objects(project_id);
CREATE INDEX IF NOT EXISTS idx_payables_project ON contractor_payables(project_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_project ON dispatch_assignments(project_id);

COMMIT;
