-- 009_ai_drafts.sql — AI/template reply drafts reviewed by staff. Mirrors db.js.
CREATE TABLE IF NOT EXISTS ai_drafts (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('message_reply','dispute_reply')),
  thread_id INTEGER REFERENCES message_threads(id) ON DELETE SET NULL,
  dispute_id INTEGER REFERENCES disputes(id) ON DELETE SET NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  audience TEXT NOT NULL CHECK (audience IN ('customer','contractor')),
  provider TEXT NOT NULL,
  model TEXT,
  body TEXT NOT NULL,
  flags TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','discarded')),
  final_body TEXT,
  edited INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
