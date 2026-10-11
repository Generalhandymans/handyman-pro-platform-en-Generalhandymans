-- 005_staff_roles.sql — team roles for admin accounts. NULL = owner (full access).
ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_role TEXT;
