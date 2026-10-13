-- 012_provider_type.sql — company technicians vs independent contractors. Mirrors db.js.
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS provider_type TEXT NOT NULL DEFAULT 'contractor' CHECK (provider_type IN ('contractor','employee'));
