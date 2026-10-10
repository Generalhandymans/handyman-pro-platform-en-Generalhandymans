-- 002_hardening.sql — mirrors the SQLite "hardening migrations" in src/db.js.
-- Idempotent: safe to run on a database that already has some of these.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS flagged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS flag_reason TEXT;
ALTER TABLE job_requests ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
ALTER TABLE job_requests ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
CREATE TABLE IF NOT EXISTS email_suppressions (
  email TEXT PRIMARY KEY,
  reason TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
