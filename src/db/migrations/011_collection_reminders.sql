-- 011_collection_reminders.sql — payment reminders to customers. Mirrors db.js.
CREATE TABLE IF NOT EXISTS collection_reminders (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sent_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  to_email TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','failed')),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_collection_reminders_project ON collection_reminders(project_id);
