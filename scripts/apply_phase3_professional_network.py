#!/usr/bin/env python3
from pathlib import Path
import shutil

ROOT=Path(__file__).resolve().parents[1]

def backup(p):
    b=p.with_name(p.name+".pre-phase3")
    if p.exists() and not b.exists(): shutil.copy2(p,b)

def insert_once(p,needle,addition):
    s=p.read_text(encoding="utf-8")
    if addition.strip() in s:return
    if needle not in s: raise RuntimeError(f"Insertion point not found in {p}: {needle}")
    backup(p); p.write_text(s.replace(needle,needle+addition,1),encoding="utf-8")

# API mount
server=ROOT/"server.js"
insert_once(server,"app.use('/api/contractors', require('./src/routes/contractors'));",
            "\napp.use('/api/contractor-ops', require('./src/routes/contractor-ops'));")

# Contractor UI assets
contractor=ROOT/"public/contractor.html"
insert_once(contractor,'<link rel="stylesheet" href="css/styles.css">',
            '\n  <link rel="stylesheet" href="css/contractor-v3.css">')
insert_once(contractor,'<script src="js/messages.js"></script>',
            '\n  <script src="js/contractor-v3.js" defer></script>')

# SQLite additive schema
db=ROOT/"src/db.js"
s=db.read_text(encoding="utf-8")
if "CREATE TABLE IF NOT EXISTS contractor_skills" not in s:
    backup(db)
    marker="CREATE INDEX IF NOT EXISTS idx_terms_ref ON terms_acceptances(kind, reference_id);"
    addition=r"""

CREATE TABLE IF NOT EXISTS contractor_skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  skill_code TEXT NOT NULL,
  proficiency TEXT NOT NULL DEFAULT 'experienced' CHECK (proficiency IN ('basic','experienced','expert')),
  years_experience INTEGER NOT NULL DEFAULT 0,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(contractor_id,skill_code)
);
CREATE TABLE IF NOT EXISTS contractor_availability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TEXT,end_time TEXT,is_available INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(contractor_id,weekday)
);
CREATE TABLE IF NOT EXISTS contractor_blackouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,end_date TEXT NOT NULL,reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS contractor_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL,label TEXT,document_number TEXT,issuer TEXT,expires_on TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','verified','rejected','expired')),
  storage_key TEXT,original_name TEXT,mime TEXT,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,reviewed_at TEXT,rejection_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS contractor_daily_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  work_date TEXT NOT NULL,summary TEXT NOT NULL,hours_worked REAL,blockers TEXT,
  customer_visible INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS contractor_offer_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('offered','viewed','accepted','declined','expired')),
  detail TEXT,created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS contractor_quality_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,points INTEGER NOT NULL DEFAULT 0,note TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS contractor_payables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  payable_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','paid','cancelled')),
  due_at TEXT,paid_at TEXT,created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contractor_skills_contractor ON contractor_skills(contractor_id);
CREATE INDEX IF NOT EXISTS idx_contractor_documents_contractor ON contractor_documents(contractor_id);
CREATE INDEX IF NOT EXISTS idx_contractor_offer_events ON contractor_offer_events(contractor_id,project_id);
CREATE INDEX IF NOT EXISTS idx_payables_contractor ON contractor_payables(contractor_id);
"""
    if marker not in s: raise RuntimeError("SQLite schema marker not found")
    db.write_text(s.replace(marker,marker+addition),encoding="utf-8")

print("HELPMAN Phase 3 applied.")
print("Run migration 003 in PostgreSQL staging, npm test, then contractor-flow QA.")
