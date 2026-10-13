#!/usr/bin/env python3
from pathlib import Path
import shutil,re

ROOT=Path(__file__).resolve().parents[1]

def backup(p):
    b=p.with_name(p.name+".pre-phase6")
    if p.exists() and not b.exists(): shutil.copy2(p,b)

def insert_once(p,needle,addition):
    s=p.read_text(encoding="utf-8")
    if addition.strip() in s:return
    if needle not in s: raise RuntimeError(f"Insertion point not found in {p}: {needle}")
    backup(p);p.write_text(s.replace(needle,needle+addition,1),encoding="utf-8")

server=ROOT/"server.js"
s=server.read_text(encoding="utf-8")

# health routes
if "require('./src/routes/health-v6')" not in s:
    marker="app.get('/api/health'"
    # Keep legacy /api/health but add namespaced detailed health before API routes.
    mount_point="// ---- API routes ----"
    if mount_point not in s: raise RuntimeError("API routes marker missing")
    backup(server)
    s=s.replace(mount_point,"app.use('/api/health', require('./src/routes/health-v6'));\napp.use('/api/growth', require('./src/routes/growth'));\n\n"+mount_point,1)

# trust proxy in production
if "app.set('trust proxy'" not in s:
    marker="const PORT = Number(process.env.PORT) || 3000;"
    s=s.replace(marker,marker+"\nif (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);",1)

server.write_text(s,encoding="utf-8")

# Admin assets
admin=ROOT/"public/admin.html"
insert_once(admin,'<link rel="stylesheet" href="css/styles.css">','\n  <link rel="stylesheet" href="css/admin-v6.css">')
insert_once(admin,'<script src="js/messages.js"></script>','\n  <script src="js/admin-v6.js" defer></script>\n  <script src="js/analytics-v6.js" defer></script>\n  <script src="js/pwa-v6.js" defer></script>')

# Public PWA/analytics on homepage
index=ROOT/"public/index.html"
s=index.read_text(encoding="utf-8")
if 'site.webmanifest' not in s:
    backup(index);s=s.replace('</head>','  <link rel="manifest" href="/site.webmanifest">\n  <meta name="theme-color" content="#0B2D5B">\n</head>',1)
if 'js/analytics-v6.js' not in s:
    s=s.replace('</body>','  <script src="/js/analytics-v6.js" defer></script>\n  <script src="/js/pwa-v6.js" defer></script>\n</body>',1)
index.write_text(s,encoding="utf-8")

# Extend .env.example documentation
env=ROOT/".env.example"
if env.exists():
    s=env.read_text(encoding="utf-8")
    add="""

# --- HELPMAN Production ---
NODE_ENV=development
PUBLIC_URL=http://localhost:3000
DATABASE_URL=
DB_SSL=false
PG_POOL_MAX=10
SERVICE_ZIPS=
SERVICE_ZIP_PREFIXES=
GA4_MEASUREMENT_ID=
GOOGLE_TAG_MANAGER_ID=
GOOGLE_SITE_VERIFICATION=
APP_VERSION=
GIT_SHA=
"""
    if "DATABASE_URL=" not in s:
        backup(env);env.write_text(s+add,encoding="utf-8")

print("HELPMAN Phase 6 applied.")
print("Next: use ops/render.production.yaml as reference; run scripts/release_qa.py and npm test before staging deploy.")
