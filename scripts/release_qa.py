#!/usr/bin/env python3
from pathlib import Path
import sys,re,json

ROOT=Path(__file__).resolve().parents[1]
errors=[]
warnings=[]

required=[
 "server.js","package.json","public/index.html","public/customer.html","public/contractor.html","public/admin.html",
 "src/routes/jobs.js","src/routes/projects.js","src/routes/payments.js","src/routes/auth.js"
]
for x in required:
    if not (ROOT/x).exists(): errors.append(f"missing: {x}")

env=(ROOT/".env.example")
if env.exists():
    txt=env.read_text(encoding="utf-8",errors="ignore")
    if "DATABASE_URL" not in txt: warnings.append(".env.example does not document DATABASE_URL")
    if "PUBLIC_URL" not in txt: warnings.append(".env.example does not document PUBLIC_URL")

server=(ROOT/"server.js")
if server.exists():
    s=server.read_text(encoding="utf-8",errors="ignore")
    if "contentSecurityPolicy: false" in s: warnings.append("CSP still disabled — finish inline-script migration before strict CSP")
    if "SEED_DEMO=true" in s and "SEED_DEMO" not in s: warnings.append("review demo seed logic")
    if "/api/payments/webhook" not in s: errors.append("Stripe webhook raw route not detected")
    if "express.raw" not in s: errors.append("Stripe raw parser not detected")

render=ROOT/"render.yaml"
if render.exists():
    r=render.read_text(encoding="utf-8",errors="ignore")
    if "DB_PATH" in r and "DATABASE_URL" not in r: warnings.append("render.yaml appears SQLite-oriented; production should use PostgreSQL")
    if "General Handyman Solutions" in r: warnings.append("legacy brand remains in render.yaml")

print("HELPMAN release QA")
print("==================")
for e in errors: print("ERROR:",e)
for w in warnings: print("WARN :",w)
print(f"Errors: {len(errors)} | Warnings: {len(warnings)}")
sys.exit(1 if errors else 0)
