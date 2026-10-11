-- 006_two_step.sql — two-step verification (TOTP) for staff accounts.
-- totp_secret is stored ENCRYPTED by the app; totp_recovery holds SHA-256 hashes only.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_recovery TEXT;
