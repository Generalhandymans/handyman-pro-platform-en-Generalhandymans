-- 008_sms_visits.sql — SMS consent/log and visit outcomes (no-shows, reschedules). Mirrors db.js.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMP;
CREATE TABLE IF NOT EXISTS sms_consents (
  phone TEXT PRIMARY KEY,
  opted_in INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sms_log (
  id SERIAL PRIMARY KEY,
  to_phone TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  provider TEXT,
  error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS visit_events (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('completed','customer_no_show','contractor_no_show','rescheduled')),
  by_user INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
