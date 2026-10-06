#!/usr/bin/env python3
from pathlib import Path
import shutil, re

ROOT = Path(__file__).resolve().parents[1]

def backup(p):
    b=p.with_name(p.name+".pre-phase2")
    if p.exists() and not b.exists(): shutil.copy2(p,b)

def insert_once(p, needle, addition):
    s=p.read_text(encoding="utf-8")
    if addition.strip() in s: return
    if needle not in s: raise RuntimeError(f"Could not find insertion point in {p}: {needle}")
    backup(p)
    p.write_text(s.replace(needle, needle+addition,1),encoding="utf-8")

# Mount the new API.
server=ROOT/"server.js"
insert_once(server,
    "app.use('/api/projects', require('./src/routes/projects'));",
    "\napp.use('/api/customer-experience', require('./src/routes/customer-experience'));")

# Add Phase 2 assets to customer portal.
customer=ROOT/"public/customer.html"
insert_once(customer,
    '<link rel="stylesheet" href="css/styles.css">',
    '\n  <link rel="stylesheet" href="css/customer-v2.css">')
insert_once(customer,
    '<script src="js/messages.js"></script>',
    '\n  <script src="js/customer-v2.js" defer></script>')

# Add service-area helper to home intake.
index=ROOT/"public/index.html"
insert_once(index,
    '<script src="js/api.js"></script>',
    '\n  <script src="js/customer-intake-v2.js" defer></script>')

# Copy-safe SQLite schema additions into src/db.js.
db=ROOT/"src/db.js"
s=db.read_text(encoding="utf-8")
if "CREATE TABLE IF NOT EXISTS change_orders" not in s:
    backup(db)
    marker="CREATE INDEX IF NOT EXISTS idx_terms_ref ON terms_acceptances(kind, reference_id);"
    addition=r"""

CREATE TABLE IF NOT EXISTS change_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  reason TEXT,
  price_delta_cents INTEGER NOT NULL DEFAULT 0,
  schedule_delta_days INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','approved','rejected','cancelled')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sent_at TEXT,
  responded_at TEXT,
  customer_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_change_orders_project ON change_orders(project_id);
CREATE INDEX IF NOT EXISTS idx_change_orders_status ON change_orders(status);

CREATE TABLE IF NOT EXISTS project_schedule_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  preferred_date TEXT,
  time_window TEXT CHECK (time_window IN ('morning','afternoon','evening','anytime')),
  flexibility TEXT CHECK (flexibility IN ('exact','plus_minus_1','plus_minus_3','flexible')),
  notes TEXT,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_customer_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  actor_role TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_customer_events_project ON project_customer_events(project_id);
"""
    if marker not in s: raise RuntimeError("SQLite schema marker not found")
    s=s.replace(marker, marker+addition)
    db.write_text(s,encoding="utf-8")

print("HELPMAN Phase 2 patch applied.")
print("Next: run PostgreSQL migration 002 in production, npm test, then manual customer-flow QA.")
