-- 004_contractor_payouts.sql — 001 already created contractor_payables (unused until now).
-- Add the payout details and guarantee ONE payable per project.
ALTER TABLE contractor_payables ADD COLUMN IF NOT EXISTS paid_method TEXT;
ALTER TABLE contractor_payables ADD COLUMN IF NOT EXISTS paid_reference TEXT;
ALTER TABLE contractor_payables ADD COLUMN IF NOT EXISTS paid_by BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE contractor_payables ADD COLUMN IF NOT EXISTS notes TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_contractor_payables_project ON contractor_payables(project_id);
