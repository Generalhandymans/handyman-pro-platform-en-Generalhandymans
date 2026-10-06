#!/usr/bin/env python3
from pathlib import Path
import shutil,re

ROOT=Path(__file__).resolve().parents[1]

def backup(p):
    b=p.with_name(p.name+".pre-phase5")
    if p.exists() and not b.exists(): shutil.copy2(p,b)

def insert_once(p,needle,addition):
    s=p.read_text(encoding="utf-8")
    if addition.strip() in s:return
    if needle not in s: raise RuntimeError(f"Insertion point not found in {p}: {needle}")
    backup(p);p.write_text(s.replace(needle,needle+addition,1),encoding="utf-8")

# Mount intelligence API.
server=ROOT/"server.js"
mount_candidates=[
    "app.use('/api/reports', require('./src/routes/reports'));",
    "app.use('/api/crm', require('./src/routes/crm'));"
]
s=server.read_text(encoding="utf-8")
if "require('./src/routes/intelligence')" not in s:
    for n in mount_candidates:
        if n in s:
            backup(server);s=s.replace(n,n+"\napp.use('/api/intelligence', require('./src/routes/intelligence'));",1);break
    else: raise RuntimeError("Could not locate API mount point in server.js")

# Request IDs + startup security.
if "requireProductionSecrets" not in s:
    needle="const app = express();"
    rep="const { requestId, requireProductionSecrets } = require('./src/services/security');\nrequireProductionSecrets();\n\nconst app = express();"
    if needle not in s: raise RuntimeError("server.js app marker missing")
    s=s.replace(needle,rep,1)
if "app.use(requestId);" not in s:
    marker="app.use(helmet({ contentSecurityPolicy: false }));"
    if marker in s:s=s.replace(marker,marker+"\napp.use(requestId);",1)
server.write_text(s,encoding="utf-8")

# Harden middleware JWT production fallback.
mw=ROOT/"src/middleware/index.js"
s=mw.read_text(encoding="utf-8")
fallback="process.env.JWT_SECRET || 'dev-only-secret-change-me'"
if fallback in s:
    backup(mw)
    s=s.replace(fallback,"process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? null : 'dev-only-secret-change-me')")
    # jwt lib will not be called with null in prod because startup check fails.
    mw.write_text(s,encoding="utf-8")

# UI assets.
admin=ROOT/"public/admin.html"
insert_once(admin,'<link rel="stylesheet" href="css/styles.css">','\n  <link rel="stylesheet" href="css/intelligence-v5.css">')
insert_once(admin,'<script src="js/messages.js"></script>','\n  <script src="js/admin-v5.js" defer></script>')

customer=ROOT/"public/customer.html"
insert_once(customer,'<link rel="stylesheet" href="css/styles.css">','\n  <link rel="stylesheet" href="css/intelligence-v5.css">')
insert_once(customer,'<script src="js/messages.js"></script>','\n  <script src="js/customer-v5.js" defer></script>')

# SQLite additive schema.
db=ROOT/"src/db.js"
s=db.read_text(encoding="utf-8")
if "CREATE TABLE IF NOT EXISTS ai_runs" not in s:
    backup(db)
    marker="CREATE INDEX IF NOT EXISTS idx_terms_ref ON terms_acceptances(kind, reference_id);"
    addition=r"""

CREATE TABLE IF NOT EXISTS ai_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,provider TEXT NOT NULL,model TEXT,
  job_request_id INTEGER REFERENCES job_requests(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  input_summary TEXT,output_json TEXT NOT NULL DEFAULT '{}',confidence INTEGER,
  status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('completed','fallback','failed')),
  error_code TEXT,duration_ms INTEGER,created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_runs_job ON ai_runs(job_request_id);
CREATE INDEX IF NOT EXISTS idx_ai_runs_project ON ai_runs(project_id);

CREATE TABLE IF NOT EXISTS job_scope_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_request_id INTEGER NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,source TEXT NOT NULL CHECK(source IN ('customer','ai','admin','contractor')),
  scope_json TEXT NOT NULL,confidence INTEGER,created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT(datetime('now')),UNIQUE(job_request_id,version_no)
);
CREATE TABLE IF NOT EXISTS risk_assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_request_id INTEGER NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
  severity TEXT NOT NULL DEFAULT 'low' CHECK(severity IN ('low','medium','high','critical')),
  flags_json TEXT NOT NULL DEFAULT '[]',requires_human_review INTEGER NOT NULL DEFAULT 0,
  requires_license_review INTEGER NOT NULL DEFAULT 0,requires_permit_review INTEGER NOT NULL DEFAULT 0,
  notes TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE TABLE IF NOT EXISTS user_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL UNIQUE,token_hash TEXT NOT NULL,user_agent TEXT,ip_prefix TEXT,
  expires_at TEXT NOT NULL,revoked_at TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now')),last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);

CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info','warning','critical')),
  ip_prefix TEXT,user_agent TEXT,detail TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(event_type);
"""
    if marker not in s: raise RuntimeError("SQLite schema marker not found")
    db.write_text(s.replace(marker,marker+addition),encoding="utf-8")

print("HELPMAN Phase 5 applied.")
print("IMPORTANT: Phase 5 enables startup secret enforcement, but CSP remains in migration mode until all inline scripts are externalized.")
