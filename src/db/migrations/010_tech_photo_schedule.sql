-- 010: contractor profile photo + arrival window + offer/schedule magic-link flow.
-- Applies to both SQLite and PostgreSQL (plain ALTER TABLE ... ADD COLUMN).

-- Profile photo (token filename served at /api/contractor-photos/:token).
-- A contractor cannot be offered a job until this is set.
ALTER TABLE contractors ADD COLUMN photo_filename TEXT;

-- Job-offer expiry: an offer not answered in 24 h is released automatically.
ALTER TABLE projects ADD COLUMN offer_expires_at TEXT;

-- Arrival window shown to the customer instead of an exact hour
-- (e.g. "2:00 PM – 4:00 PM"). The scheduling UI reminds dispatch that
-- the time must stay flexible.
ALTER TABLE projects ADD COLUMN arrival_window TEXT;

-- Contractor's answer to the confirmed schedule (day + window).
ALTER TABLE projects ADD COLUMN schedule_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE projects ADD COLUMN schedule_token TEXT;
ALTER TABLE projects ADD COLUMN schedule_expires_at TEXT;
