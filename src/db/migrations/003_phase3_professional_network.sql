BEGIN;

CREATE TABLE IF NOT EXISTS contractor_skills (
  id BIGSERIAL PRIMARY KEY,
  contractor_id BIGINT NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  skill_code TEXT NOT NULL,
  proficiency TEXT NOT NULL DEFAULT 'experienced'
    CHECK (proficiency IN ('basic','experienced','expert')),
  years_experience INTEGER NOT NULL DEFAULT 0,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(contractor_id, skill_code)
);

CREATE TABLE IF NOT EXISTS contractor_availability (
  id BIGSERIAL PRIMARY KEY,
  contractor_id BIGINT NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TEXT,
  end_time TEXT,
  is_available INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(contractor_id, weekday)
);

CREATE TABLE IF NOT EXISTS contractor_blackouts (
  id BIGSERIAL PRIMARY KEY,
  contractor_id BIGINT NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contractor_documents (
  id BIGSERIAL PRIMARY KEY,
  contractor_id BIGINT NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL CHECK (doc_type IN (
    'license','insurance','workers_comp','w9','business_registration','background_consent','other'
  )),
  label TEXT,
  document_number TEXT,
  issuer TEXT,
  expires_on TEXT,
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','verified','rejected','expired')),
  storage_key TEXT,
  original_name TEXT,
  mime TEXT,
  reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contractor_daily_logs (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contractor_id BIGINT NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  work_date TEXT NOT NULL,
  summary TEXT NOT NULL,
  hours_worked DOUBLE PRECISION,
  blockers TEXT,
  customer_visible INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contractor_offer_events (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contractor_id BIGINT NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('offered','viewed','accepted','declined','expired')),
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contractor_quality_events (
  id BIGSERIAL PRIMARY KEY,
  contractor_id BIGINT NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contractor_payables (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contractor_id BIGINT NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  payable_cents BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','paid','cancelled')),
  due_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contractor_skills_contractor ON contractor_skills(contractor_id);
CREATE INDEX IF NOT EXISTS idx_contractor_availability_contractor ON contractor_availability(contractor_id);
CREATE INDEX IF NOT EXISTS idx_contractor_documents_contractor ON contractor_documents(contractor_id);
CREATE INDEX IF NOT EXISTS idx_contractor_documents_status ON contractor_documents(status);
CREATE INDEX IF NOT EXISTS idx_contractor_logs_project ON contractor_daily_logs(project_id);
CREATE INDEX IF NOT EXISTS idx_contractor_offer_events ON contractor_offer_events(contractor_id, project_id);
CREATE INDEX IF NOT EXISTS idx_contractor_quality_events ON contractor_quality_events(contractor_id);
CREATE INDEX IF NOT EXISTS idx_payables_contractor ON contractor_payables(contractor_id);

COMMIT;
