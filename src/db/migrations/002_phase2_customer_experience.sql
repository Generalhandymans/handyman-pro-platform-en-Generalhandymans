BEGIN;

CREATE TABLE IF NOT EXISTS change_orders (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  reason TEXT,
  price_delta_cents INTEGER NOT NULL DEFAULT 0,
  schedule_delta_days INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','sent','approved','rejected','cancelled')),
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  sent_at TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,
  customer_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_change_orders_project ON change_orders(project_id);
CREATE INDEX IF NOT EXISTS idx_change_orders_status ON change_orders(status);

CREATE TABLE IF NOT EXISTS project_schedule_preferences (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  preferred_date TEXT,
  time_window TEXT CHECK (time_window IN ('morning','afternoon','evening','anytime')),
  flexibility TEXT CHECK (flexibility IN ('exact','plus_minus_1','plus_minus_3','flexible')),
  notes TEXT,
  updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_customer_events (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  actor_role TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_events_project ON project_customer_events(project_id);

COMMIT;
