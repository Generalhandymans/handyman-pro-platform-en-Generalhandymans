#!/usr/bin/env python3
from pathlib import Path
import shutil

ROOT=Path(__file__).resolve().parents[1]

def backup(p):
    b=p.with_name(p.name+".pre-phase4")
    if p.exists() and not b.exists(): shutil.copy2(p,b)

def insert_once(p,needle,addition):
    s=p.read_text(encoding="utf-8")
    if addition.strip() in s:return
    if needle not in s: raise RuntimeError(f"Insertion point not found in {p}: {needle}")
    backup(p)
    p.write_text(s.replace(needle,needle+addition,1),encoding="utf-8")

server=ROOT/"server.js"
# Try best known mount point.
needle="app.use('/api/crm', require('./src/routes/crm'));"
insert_once(server,needle,"\napp.use('/api/operations', require('./src/routes/operations'));")

admin=ROOT/"public/admin.html"
insert_once(admin,'<link rel="stylesheet" href="css/styles.css">',
            '\n  <link rel="stylesheet" href="css/admin-v4.css">')
insert_once(admin,'<script src="js/messages.js"></script>',
            '\n  <script src="js/admin-v4.js" defer></script>')

db=ROOT/"src/db.js"
s=db.read_text(encoding="utf-8")
if "CREATE TABLE IF NOT EXISTS operations_tasks" not in s:
    backup(db)
    marker="CREATE INDEX IF NOT EXISTS idx_terms_ref ON terms_acceptances(kind, reference_id);"
    addition=r"""

CREATE TABLE IF NOT EXISTS operations_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,detail TEXT,entity_type TEXT,entity_id INTEGER,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','blocked','done','dismissed')),
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,due_at TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','system','sla','payment','dispatch','compliance','customer')),
  fingerprint TEXT,created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  completed_at TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ops_tasks_status_priority ON operations_tasks(status,priority);
CREATE INDEX IF NOT EXISTS idx_ops_tasks_assignee ON operations_tasks(assigned_to);

CREATE TABLE IF NOT EXISTS operations_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,entity_id INTEGER NOT NULL,body TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'internal' CHECK(visibility IN ('internal')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ops_notes_entity ON operations_notes(entity_type,entity_id);

CREATE TABLE IF NOT EXISTS sla_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,code TEXT NOT NULL UNIQUE,label TEXT NOT NULL,
  threshold_minutes INTEGER NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
INSERT OR IGNORE INTO sla_policies(code,label,threshold_minutes,enabled) VALUES
 ('new_lead_first_action','New lead first action',60,1),
 ('quote_response_followup','Quote follow-up',2880,1),
 ('unassigned_project','Accepted project assignment',240,1),
 ('contractor_offer_response','Contractor offer response',120,1),
 ('customer_approval_wait','Customer approval wait',2880,1),
 ('payment_failure','Payment failure attention',30,1);

CREATE TABLE IF NOT EXISTS operations_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,event_type TEXT NOT NULL,entity_type TEXT,entity_id INTEGER,
  severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info','warning','critical')),
  summary TEXT NOT NULL,detail TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ops_events_created ON operations_events(created_at);
CREATE TABLE IF NOT EXISTS dispatch_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  match_score REAL,
  status TEXT NOT NULL DEFAULT 'offered' CHECK(status IN ('offered','accepted','declined','expired','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dispatch_assignments_project ON dispatch_assignments(project_id);

"""
    if marker not in s: raise RuntimeError("SQLite schema marker not found")
    db.write_text(s.replace(marker,marker+addition),encoding="utf-8")

print("HELPMAN Phase 4 applied.")
print("Run PostgreSQL migration 004 in staging, npm test, then Operations QA.")
