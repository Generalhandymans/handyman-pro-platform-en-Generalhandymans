-- 003_completion_sheets.sql — mirrors the SQLite table in src/db.js.
CREATE TABLE IF NOT EXISTS completion_sheets (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  signer_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  signer_name TEXT NOT NULL,
  signature_png TEXT NOT NULL,
  checklist_json TEXT,
  notes TEXT,
  ip TEXT,
  signed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
