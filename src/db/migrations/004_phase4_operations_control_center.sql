BEGIN;

CREATE TABLE IF NOT EXISTS operations_tasks (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  detail TEXT,
  entity_type TEXT,
  entity_id BIGINT,
  priority TEXT NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('low','medium','high','critical')),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','in_progress','blocked','done','dismissed')),
  assigned_to BIGINT REFERENCES users(id) ON DELETE SET NULL,
  due_at TIMESTAMPTZ,
  source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual','system','sla','payment','dispatch','compliance','customer')),
  fingerprint TEXT,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_tasks_fingerprint_open
  ON operations_tasks(fingerprint)
  WHERE fingerprint IS NOT NULL AND status IN ('open','in_progress','blocked');

CREATE INDEX IF NOT EXISTS idx_ops_tasks_status_priority
  ON operations_tasks(status, priority);
CREATE INDEX IF NOT EXISTS idx_ops_tasks_assignee
  ON operations_tasks(assigned_to);

CREATE TABLE IF NOT EXISTS operations_notes (
  id BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id BIGINT NOT NULL,
  body TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'internal'
    CHECK (visibility IN ('internal')),
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ops_notes_entity
  ON operations_notes(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS sla_policies (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  threshold_minutes INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO sla_policies(code,label,threshold_minutes,enabled)
VALUES
  ('new_lead_first_action','New lead first action',60,1),
  ('quote_response_followup','Quote follow-up',2880,1),
  ('unassigned_project','Accepted project assignment',240,1),
  ('contractor_offer_response','Contractor offer response',120,1),
  ('customer_approval_wait','Customer approval wait',2880,1),
  ('payment_failure','Payment failure attention',30,1)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS operations_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id BIGINT,
  severity TEXT NOT NULL DEFAULT 'info'
    CHECK (severity IN ('info','warning','critical')),
  summary TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ops_events_created
  ON operations_events(created_at);
CREATE INDEX IF NOT EXISTS idx_ops_events_entity
  ON operations_events(entity_type, entity_id);


CREATE TABLE IF NOT EXISTS dispatch_assignments (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contractor_id BIGINT NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  match_score REAL,
  status TEXT NOT NULL DEFAULT 'offered'
    CHECK (status IN ('offered','accepted','declined','expired','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dispatch_assignments_project ON dispatch_assignments(project_id);

COMMIT;
