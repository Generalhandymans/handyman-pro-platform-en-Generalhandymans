BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email CITEXT NOT NULL UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('customer','contractor','admin')),
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  verify_token_hash TEXT,
  verify_expires_at TIMESTAMPTZ,
  reset_token_hash TEXT,
  reset_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contractors (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  legal_name TEXT NOT NULL,
  city TEXT,
  state CHAR(2),
  postal_code TEXT,
  base_lat NUMERIC(9,6),
  base_lng NUMERIC(9,6),
  service_radius_miles INT NOT NULL DEFAULT 25,
  years_experience INT NOT NULL DEFAULT 0,
  specialties JSONB NOT NULL DEFAULT '[]'::jsonb,
  license_number TEXT,
  license_state CHAR(2),
  license_expires_at DATE,
  insurance_provider TEXT,
  insurance_policy_number TEXT,
  insurance_expires_at DATE,
  license_verified BOOLEAN NOT NULL DEFAULT FALSE,
  insurance_verified BOOLEAN NOT NULL DEFAULT FALSE,
  background_check TEXT NOT NULL DEFAULT 'pending'
    CHECK (background_check IN ('pending','passed','failed')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','active','suspended','inactive')),
  rating_avg NUMERIC(3,2) NOT NULL DEFAULT 0,
  jobs_completed INT NOT NULL DEFAULT 0,
  acceptance_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  completion_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  current_workload INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS job_requests (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  address TEXT NOT NULL,
  city TEXT,
  state CHAR(2),
  zip TEXT,
  latitude NUMERIC(9,6),
  longitude NUMERIC(9,6),
  service_type TEXT NOT NULL,
  urgency TEXT NOT NULL DEFAULT 'standard'
    CHECK (urgency IN ('standard','urgent','emergency')),
  description TEXT NOT NULL,
  scope_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'new',
  lead_score INT NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'web',
  claim_token_hash TEXT,
  assigned_market TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS media_objects (
  id BIGSERIAL PRIMARY KEY,
  job_request_id BIGINT REFERENCES job_requests(id) ON DELETE CASCADE,
  project_id BIGINT,
  storage_key TEXT NOT NULL UNIQUE,
  original_name TEXT,
  mime TEXT NOT NULL,
  size_bytes BIGINT,
  width INT,
  height INT,
  kind TEXT NOT NULL DEFAULT 'request'
    CHECK (kind IN ('request','progress','completion','document')),
  sha256 TEXT,
  uploaded_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ai_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS estimates (
  id BIGSERIAL PRIMARY KEY,
  job_request_id BIGINT NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
  low_cents BIGINT NOT NULL,
  high_cents BIGINT NOT NULL,
  recommended_cents BIGINT,
  line_items_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  missing_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  risks_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence INT NOT NULL DEFAULT 0,
  factors_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  engine_version TEXT NOT NULL,
  ai_assist_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quotes (
  id BIGSERIAL PRIMARY KEY,
  job_request_id BIGINT NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
  estimate_id BIGINT REFERENCES estimates(id) ON DELETE SET NULL,
  customer_price_cents BIGINT NOT NULL,
  contractor_cost_cents BIGINT NOT NULL,
  deposit_cents BIGINT NOT NULL,
  deposit_pct INT NOT NULL DEFAULT 30,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','sent','accepted','rejected','expired','cancelled')),
  valid_until TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
  id BIGSERIAL PRIMARY KEY,
  job_request_id BIGINT NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
  quote_id BIGINT REFERENCES quotes(id) ON DELETE SET NULL,
  contractor_id BIGINT REFERENCES contractors(id) ON DELETE SET NULL,
  contractor_status TEXT
    CHECK (contractor_status IN ('offered','accepted','declined')),
  stage TEXT NOT NULL DEFAULT 'assigned'
    CHECK (stage IN ('assigned','scheduled','in_progress','review','completed','cancelled')),
  scheduled_start TIMESTAMPTZ,
  scheduled_end TIMESTAMPTZ,
  customer_price_cents BIGINT NOT NULL,
  contractor_cost_cents BIGINT NOT NULL,
  actual_materials_cents BIGINT NOT NULL DEFAULT 0,
  actual_labor_cents BIGINT NOT NULL DEFAULT 0,
  actual_other_cents BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE media_objects
  ADD CONSTRAINT media_project_fk
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS milestones (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_progress','completed')),
  customer_approval TEXT NOT NULL DEFAULT 'pending'
    CHECK (customer_approval IN ('pending','approved','rejected')),
  amount_cents BIGINT NOT NULL DEFAULT 0,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('deposit','milestone','final','refund')),
  amount_cents BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('recorded','pending','paid','failed','refunded','partially_refunded')),
  provider TEXT NOT NULL DEFAULT 'manual'
    CHECK (provider IN ('manual','stripe')),
  provider_ref TEXT UNIQUE,
  provider_fee_cents BIGINT NOT NULL DEFAULT 0,
  refunded_cents BIGINT NOT NULL DEFAULT 0,
  notes TEXT,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stripe_events (
  id BIGSERIAL PRIMARY KEY,
  stripe_event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contractor_payables (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contractor_id BIGINT NOT NULL REFERENCES contractors(id) ON DELETE RESTRICT,
  milestone_id BIGINT REFERENCES milestones(id) ON DELETE SET NULL,
  gross_cents BIGINT NOT NULL,
  adjustment_cents BIGINT NOT NULL DEFAULT 0,
  payable_cents BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','paid','held','cancelled')),
  approved_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  payout_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dispatch_assignments (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contractor_id BIGINT NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  score NUMERIC(5,2) NOT NULL,
  distance_miles NUMERIC(8,2),
  explanation JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'recommended'
    CHECK (status IN ('recommended','offered','accepted','rejected','expired')),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_recommendations (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id BIGINT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('low','medium','high','critical')),
  title TEXT NOT NULL,
  explanation TEXT NOT NULL,
  confidence NUMERIC(5,2),
  action_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','accepted','dismissed','executed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  actor_role TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id BIGINT,
  ip INET,
  user_agent TEXT,
  request_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON job_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_stage_schedule ON projects(stage, scheduled_start);
CREATE INDEX IF NOT EXISTS idx_contractors_status ON contractors(status);
CREATE INDEX IF NOT EXISTS idx_payments_project ON payments(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payables_contractor_status ON contractor_payables(contractor_id, status);
CREATE INDEX IF NOT EXISTS idx_dispatch_project_score ON dispatch_assignments(project_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_ai_open_priority ON ai_recommendations(status, priority, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity_type, entity_id, created_at DESC);

COMMIT;
