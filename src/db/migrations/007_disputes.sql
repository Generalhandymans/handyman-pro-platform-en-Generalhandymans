-- 007_disputes.sql — mirrors the SQLite tables in src/db.js.
CREATE TABLE IF NOT EXISTS disputes (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  opened_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  opened_by_role TEXT NOT NULL CHECK (opened_by_role IN ('customer','contractor')),
  reason TEXT NOT NULL CHECK (reason IN ('quality','incomplete','no_show','damage','billing','other')),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved','withdrawn')),
  resolution TEXT CHECK (resolution IS NULL OR resolution IN ('no_action','rework','partial_refund','full_refund')),
  resolution_notes TEXT,
  refund_cents INTEGER NOT NULL DEFAULT 0,
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_dispute_open_per_project ON disputes(project_id) WHERE status IN ('open','investigating');
CREATE TABLE IF NOT EXISTS dispute_events (
  id SERIAL PRIMARY KEY,
  dispute_id INTEGER NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author_role TEXT NOT NULL CHECK (author_role IN ('customer','contractor','admin')),
  visibility TEXT NOT NULL CHECK (visibility IN ('customer','contractor','staff')),
  body TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
