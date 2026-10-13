BEGIN;

CREATE TABLE IF NOT EXISTS ai_runs (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  job_request_id BIGINT REFERENCES job_requests(id) ON DELETE CASCADE,
  project_id BIGINT REFERENCES projects(id) ON DELETE CASCADE,
  input_summary TEXT,
  output_json TEXT NOT NULL DEFAULT '{}',
  confidence INTEGER,
  status TEXT NOT NULL DEFAULT 'completed'
    CHECK (status IN ('completed','fallback','failed')),
  error_code TEXT,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_runs_job ON ai_runs(job_request_id);
CREATE INDEX IF NOT EXISTS idx_ai_runs_project ON ai_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_ai_runs_kind ON ai_runs(kind);

CREATE TABLE IF NOT EXISTS job_scope_versions (
  id BIGSERIAL PRIMARY KEY,
  job_request_id BIGINT NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('customer','ai','admin','contractor')),
  scope_json TEXT NOT NULL,
  confidence INTEGER,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(job_request_id, version_no)
);

CREATE TABLE IF NOT EXISTS risk_assessments (
  id BIGSERIAL PRIMARY KEY,
  job_request_id BIGINT NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
  severity TEXT NOT NULL DEFAULT 'low'
    CHECK (severity IN ('low','medium','high','critical')),
  flags_json TEXT NOT NULL DEFAULT '[]',
  requires_human_review INTEGER NOT NULL DEFAULT 0,
  requires_license_review INTEGER NOT NULL DEFAULT 0,
  requires_permit_review INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL,
  user_agent TEXT,
  ip_prefix TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expiry ON user_sessions(expires_at);

CREATE TABLE IF NOT EXISTS security_events (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info'
    CHECK (severity IN ('info','warning','critical')),
  ip_prefix TEXT,
  user_agent TEXT,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(event_type);
CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at);

COMMIT;
