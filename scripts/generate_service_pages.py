#!/usr/bin/env python3
"""
Generate HELPMAN service-area landing pages from an explicit JSON config.
Never invent cities or coverage. Only publish configured, real service areas.
"""
from pathlib import Path
import json, html, re

ROOT=Path(__file__).resolve().parents[1]
CFG=ROOT/"ops/service-areas.json"
OUT=ROOT/"public/services"
OUT.mkdir(parents=True,exist_ok=True)

if not CFG.exists():
    raise SystemExit("Create ops/service-areas.json from ops/service-areas.example.json first.")

cfg=json.loads(CFG.read_text(encoding="utf-8"))
brand=cfg.get("brand","HELPMAN")
base=cfg.get("base_url","https://helpman.app").rstrip("/")

def slug(s):
    return re.sub(r'[^a-z0-9]+','-',s.lower()).strip('-')

pages=[]
for area in cfg.get("areas",[]):
    city=area["city"]; state=area["state"]; services=area.get("services",[])
    if not area.get("active",False): continue
    for svc in services:
        label=svc["label"]; code=svc["code"]; path=f"/services/{slug(label)}-{slug(city)}-{slug(state)}.html"
        title=f"{label} in {city}, {state} | {brand}"
        desc=f"Request {label.lower()} help in {city}, {state}. Describe the project, upload photos, review your project scope, and track work through HELPMAN."
        structured={
          "@context":"https://schema.org",
          "@type":"Service",
          "name":label,
          "areaServed":{"@type":"City","name":city},
          "provider":{"@type":"Organization","name":brand,"url":base}
        }
        body=f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(title)}</title>
<meta name="description" content="{html.escape(desc)}">
<link rel="canonical" href="{base}{path}">
<link rel="stylesheet" href="/css/styles.css">
<link rel="stylesheet" href="/css/helpman-v2.css">
<script type="application/ld+json">{json.dumps(structured)}</script>
</head><body>
<header class="site-header" id="site-header"></header>
<main class="wrap">
<section class="hero">
<div><span class="eyebrow">{html.escape(city)}, {html.escape(state)}</span>
<h1>{html.escape(label)} — home projects, handled.</h1>
<p>{html.escape(desc)}</p>
<div class="btn-row"><a class="btn btn-primary" href="/index.html#request">Start a request</a><a class="btn btn-outline" href="/track.html">Track a project</a></div>
</div>
</section>
<section class="card">
<h2>How HELPMAN works</h2>
<p>Tell us what you need, add photos, review the project scope and planning estimate, then move through quote, scheduling, project tracking, approvals and payment in one place.</p>
</section>
<section class="card">
<h2>Service-area note</h2>
<p>Availability depends on current contractor coverage and project requirements. Submission of a request does not guarantee immediate booking.</p>
</section>
</main>
<script src="/js/api.js"></script><script src="/js/pwa-v6.js"></script>
</body></html>"""
        fp=OUT/path.split("/")[-1]
        fp.write_text(body,encoding="utf-8")
        pages.append(base+path)

sitemap=ROOT/"public/sitemap.generated.xml"
urls=[base+"/"]+pages
xml='<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
xml+=''.join(f'  <url><loc>{html.escape(u)}</loc></url>\n' for u in urls)
xml+='</urlset>\n'
sitemap.write_text(xml,encoding="utf-8")
print(f"Generated {len(pages)} service pages and sitemap.generated.xml")
