#!/usr/bin/env python3
from pathlib import Path
import re, shutil

ROOT = Path(__file__).resolve().parent  # ADAPTED: script lives at repo root in this run

TEXT_GLOBS = [
    "public/*.html","public/js/*.js","src/**/*.js","server.js",
    "package.json","README.md","API.md","ARCHITECTURE.md","ROADMAP.md"
]

def iter_files():
    seen=set()
    for g in TEXT_GLOBS:
        for p in ROOT.glob(g):
            if p.is_file() and p not in seen:
                seen.add(p); yield p

def backup(p):
    b=p.with_name(p.name+".pre-helpman-v2")
    if not b.exists(): shutil.copy2(p,b)

def repl(p, pairs):
    s=p.read_text(encoding="utf-8"); old=s
    for a,b in pairs: s=s.replace(a,b)
    if s!=old:
        backup(p); p.write_text(s,encoding="utf-8"); return True
    return False

def regex(p, pattern, replacement):
    s=p.read_text(encoding="utf-8")
    n=re.sub(pattern,replacement,s,flags=re.S)
    if n!=s:
        backup(p); p.write_text(n,encoding="utf-8"); return True
    return False

# 1. Brand architecture
for p in iter_files():
    if p.name in {"terms.html","privacy.html","contractor-terms.html"}:
        repl(p,[("General Handyman Solutions","Helpman, operated by General Handyman Solutions")])
    else:
        repl(p,[("General Handyman Solutions","Helpman"),
                ("general-handyman-solutions-platform","helpman-platform"),
                ("general-handyman-solutions","helpman")])

# 2. Shared header brand (ADAPTED 2026-10-06: api.js keeps the header in a JS
# template literal with PLAIN quotes and real newlines (verified with od -c).
# Use the redrawn SVG logo (no R-mark) instead of the span wordmark.)
api=ROOT/"public/js/api.js"
if api.exists():
    repl(api,[(
        '<a class="brand" href="index.html" aria-label="Helpman home">\n          <img class="brand-logo" src="img/logo-header.jpg" alt="Helpman">\n        </a>',
        '<a class="brand" href="index.html" aria-label="Helpman home">\n          <img class="helpman-logo" src="img/helpman-logo.svg" alt="Helpman \u2014 Home projects, handled.">\n        </a>'
    )])

idx=ROOT/"public/index.html"
if idx.exists():
    repl(idx,[
        ('<title>Helpman — Trusted home repairs, one request away</title>','<title>Helpman — Home projects, handled</title>'),
        ('<meta name="description" content="Helpman is a managed handyman marketplace: instant estimates, vetted pros, upfront pricing, and tracking from request to done.">',
         '<meta name="description" content="Tell Helpman what your home needs. Get a planning estimate, review a clear quote, and manage your project from request through completion in one place.">'),
        ('<link rel="stylesheet" href="css/styles.css">',
         '<link rel="stylesheet" href="css/styles.css">\n  <link rel="stylesheet" href="css/helpman-v2.css">\n  <meta name="theme-color" content="#102033">\n  <meta property="og:title" content="Helpman — Home projects, handled">\n  <meta property="og:description" content="Describe the job, review a clear quote, and track the work from start to finish.">\n  <meta property="og:type" content="website">')
    ])

    hero = """<!-- Hero -->
    <section class="hero hm-hero">
      <div class="wrap hm-hero-grid">
        <div>
          <span class="hm-kicker">One request. One project. One place to manage it.</span>
          <h1>Tell us what your home needs. <span class="hl">Helpman handles the rest.</span></h1>
          <p class="lead">Describe the work, add photos, get a planning estimate, and move forward with a clear quote and project tracking — without chasing multiple providers.</p>
          <div class="hm-hero-actions">
            <button class="btn btn-primary" id="cta-estimate">Start my request</button>
            <a class="btn btn-ghost" href="track.html">Track a project</a>
          </div>
          <div class="hm-trustline" aria-label="Platform benefits">
            <span><b>✓</b> No payment to request an estimate</span>
            <span><b>✓</b> Project updates in one place</span>
            <span><b>✓</b> Approval checkpoints before key steps</span>
          </div>
        </div>
        <aside class="hm-request-card" aria-label="Request preview">
          <h2>What needs to be done?</h2>
          <div class="hm-request-box">Example: “I need two bathroom faucets replaced and a small drywall patch repaired.”</div>
          <div class="hm-request-meta">
            <div class="hm-mini"><strong>Add photos</strong><span>Help us understand the scope</span></div>
            <div class="hm-mini"><strong>Add ZIP code</strong><span>Confirm service availability</span></div>
          </div>
          <button class="btn btn-dark" type="button" id="cta-estimate-card" style="width:100%;margin-top:.85rem">Get started</button>
          <p class="hm-disclaimer" style="margin:.7rem 0 0">Planning estimates are informational and may change after scope review. A final quote must be accepted before paid work begins.</p>
        </aside>
      </div>
    </section>"""
    regex(idx,r'<!-- Hero -->.*?</section>',hero)

    trust = """<!-- Helpman value -->
      <section class="hm-section" aria-labelledby="trust-title">
        <div class="hm-section-head"><span class="eyebrow">Why Helpman</span><h2 id="trust-title">A project workflow, not just another lead list.</h2><p>Helpman is designed to organize the job from the first request through completion, with clearer scope, documented progress and fewer handoff gaps.</p></div>
        <div class="hm-value-grid">
          <article class="hm-value"><div class="hm-value-icon">01</div><h3>Clearer scope</h3><p>Structured questions and photos help define the job before a final quote is accepted.</p></article>
          <article class="hm-value"><div class="hm-value-icon">02</div><h3>Visible progress</h3><p>Keep project stages, photos, messages and approvals connected to the same job record.</p></article>
          <article class="hm-value"><div class="hm-value-icon">03</div><h3>Managed workflow</h3><p>Helpman coordinates the process so customers and professionals know what happens next.</p></article>
        </div>
      </section>
      <section class="hm-section" aria-labelledby="protection-title">
        <div class="hm-protection">
          <div><span class="eyebrow" style="color:#9fc2ff">Helpman Project Controls</span><h2 id="protection-title" style="font-size:clamp(2rem,4vw,3.25rem);letter-spacing:-.045em;margin:.5rem 0">More visibility before the project moves forward.</h2><p>Key project actions should be documented in the platform, including scope, quote acceptance, milestone progress and customer approvals when applicable.</p></div>
          <div class="hm-protection-list">
            <div class="hm-protection-item"><strong>✓</strong><span>Review the quoted scope before booking.</span></div>
            <div class="hm-protection-item"><strong>✓</strong><span>Follow progress and project photos in one record.</span></div>
            <div class="hm-protection-item"><strong>✓</strong><span>Document changes instead of relying on verbal agreements.</span></div>
            <div class="hm-protection-item"><strong>✓</strong><span>Keep a history of approvals and project communication.</span></div>
          </div>
        </div>
      </section>"""
    regex(idx,r'<!-- Trust -->.*?</section>',trust)

    repl(idx,[
        ("Instant price range before you commit to anything.","A planning price range before you decide whether to proceed."),
        ("Fixed quotes from licensed, background-checked pros.","Review a clear quote and the professional assigned to your project."),
        ("Join the Helpman contractor network. We bring you steady, pre-qualified jobs — you bring the craft.","Join the Helpman professional network. Receive structured job opportunities with scope details and project history in one place."),
        ("Qualified job leads with upfront details and photos — no cold calling.","Job opportunities with structured details and customer-provided photos when available."),
        ("Clear milestones and fast payouts as each phase is approved.","Clear milestones and payout tracking tied to project progress."),
        ("We handle marketing, estimates, and customer support for you.","The platform helps organize intake, estimates, communication and project administration."),
        ("This is a planning estimate. A fixed quote follows after our review — nothing is charged now.","This is a planning estimate, not a final price. A final quote follows after scope review and must be accepted before paid work begins."),
        ("runs our instant estimate","runs our planning estimate"),
        ("Your estimate","Your planning estimate"),
        ("Instant price range","Planning price range"),
        ("document.getElementById('cta-estimate-2').addEventListener('click', () => openWizard(''));",
         "document.getElementById('cta-estimate-2').addEventListener('click', () => openWizard(''));\n    const heroCardCta = document.getElementById('cta-estimate-card');\n    if (heroCardCta) heroCardCta.addEventListener('click', () => openWizard(''));")
    ])

    footer = """<footer class="site-footer">
    <div class="wrap">
      <div><div class="hm-footer-brand">HELPMAN</div><p>Home projects, handled — from request and planning estimate through project tracking.</p><p class="hm-legal-operator">Helpman is operated by General Handyman Solutions.</p></div>
      <div><h4>Customers</h4><p><a href="#" id="foot-estimate">Start a request</a><br><a href="track.html">Track a project</a><br><a href="auth.html">Log in / Sign up</a></p></div>
      <div><h4>Professionals</h4><p><a href="auth.html?tab=contractor">Join the network</a><br><a href="contractor-terms.html">Professional terms</a></p></div>
      <div><h4>Company</h4><p><a href="about.html">About Helpman</a><br><a href="project-controls.html">Project controls</a><br><a href="privacy.html">Privacy</a></p></div>
      <div class="fine" style="grid-column:1/-1">© 2026 Helpman / General Handyman Solutions. All rights reserved. · <a href="terms.html">Terms of Service</a> · <a href="privacy.html">Privacy Policy</a></div>
    </div>
  </footer>"""
    regex(idx,r'<footer class="site-footer">.*?</footer>',footer)

# Conservative claim cleanup on public pages
claims=[
 ("Licensed, insured, background-checked contractors assigned to every job.","Professionals are reviewed against the verification information required for the applicable job and market."),
 ("Every contractor passes license, insurance, and background checks before touching a job.","Professional verification status is reviewed and documented based on the requirements applicable to the job."),
 ("Fixed quotes with a clear breakdown. You always know what you pay and why.","Review the quoted scope and price before accepting paid work."),
 ("No surprise charges, no unfinished work.","Project changes should be documented and approved before they are added to the scope."),
 ("instant estimates","planning estimates"),("Instant estimates","Planning estimates")
]
for p in (ROOT/"public").glob("*.html"): repl(p,claims)

# Production hardening
server=ROOT/"server.js"
if server.exists():
    repl(server,[
      ("const app = express();\nconst PORT = Number(process.env.PORT) || 3000;",
       "const app = express();\nconst PORT = Number(process.env.PORT) || 3000;\nif (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);"),
      ("app.use(helmet({ contentSecurityPolicy: false }));",
       "app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-origin' } }));\napp.disable('x-powered-by');")
    ])

mw=ROOT/"src/middleware/index.js"
if mw.exists():
    repl(mw,[(
      "const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';\nif (!process.env.JWT_SECRET) {\n  console.warn('[warn] JWT_SECRET not set — using insecure dev default. Set it in .env');\n}",
      "const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';\nif (!process.env.JWT_SECRET) {\n  if (process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET is required in production. Refusing to start with the development fallback.');\n  console.warn('[warn] JWT_SECRET not set — using insecure dev default. Set it in .env');\n}"
    )])

# New pages & SEO files
(ROOT/"public/about.html").write_text('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>About Helpman</title><meta name="description" content="About Helpman and its managed home-project workflow."><link rel="icon" href="favicon.svg"><link rel="stylesheet" href="css/styles.css"><link rel="stylesheet" href="css/helpman-v2.css"></head><body><header class="site-header" id="site-header"></header><main><section class="hm-section"><div class="wrap"><div class="hm-section-head"><span class="eyebrow">About</span><h1>Home projects are complicated. The workflow should not be.</h1><p>Helpman is a managed home-services platform designed to organize request intake, scope, estimates, quotes, project progress and customer approvals in one place.</p></div><div class="hm-value-grid"><article class="hm-value"><div class="hm-value-icon">01</div><h3>Customer clarity</h3><p>Structured project information helps customers understand what is being requested and what happens next.</p></article><article class="hm-value"><div class="hm-value-icon">02</div><h3>Professional workflow</h3><p>Pros receive organized project details instead of disconnected calls, texts and photos.</p></article><article class="hm-value"><div class="hm-value-icon">03</div><h3>Documented progress</h3><p>Milestones, messages, photos and approvals remain attached to the project record.</p></article></div><p class="hm-disclaimer" style="margin-top:2rem">Helpman is operated by General Handyman Solutions. Service availability, professional requirements and project terms vary by job and jurisdiction.</p></div></section></main><script src="js/api.js"></script><script>HP.mountHeader(\'about\');</script></body></html>',encoding="utf-8")
(ROOT/"public/project-controls.html").write_text('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Helpman Project Controls</title><meta name="description" content="How Helpman organizes quotes, milestones, project photos, approvals and changes."><link rel="icon" href="favicon.svg"><link rel="stylesheet" href="css/styles.css"><link rel="stylesheet" href="css/helpman-v2.css"></head><body><header class="site-header" id="site-header"></header><main><section class="hm-section"><div class="wrap"><div class="hm-section-head"><span class="eyebrow">Project controls</span><h1>Keep important project decisions attached to the project.</h1><p>Helpman is designed to reduce ambiguity by keeping scope, quote acceptance, milestone progress, photos and documented changes in one workflow.</p></div><div class="hm-value-grid"><article class="hm-value"><div class="hm-value-icon">A</div><h3>Scope & quote</h3><p>Review the scope and quoted price before accepting paid work.</p></article><article class="hm-value"><div class="hm-value-icon">B</div><h3>Progress record</h3><p>Track milestones and project photos as work advances.</p></article><article class="hm-value"><div class="hm-value-icon">C</div><h3>Changes</h3><p>Material changes should be documented and approved rather than handled only verbally.</p></article></div><p class="hm-disclaimer" style="margin-top:2rem">These controls describe platform workflow and are not a warranty, insurance policy or substitute for any contract, licensing, permit or consumer-protection requirement that applies to a specific project.</p></div></section></main><script src="js/api.js"></script><script>HP.mountHeader(\'\');</script></body></html>',encoding="utf-8")
(ROOT/"public/robots.txt").write_text("User-agent: *\nAllow: /\nSitemap: https://helpman.app/sitemap.xml\n",encoding="utf-8")
(ROOT/"public/sitemap.xml").write_text('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://helpman.app/</loc></url><url><loc>https://helpman.app/about.html</loc></url><url><loc>https://helpman.app/project-controls.html</loc></url><url><loc>https://helpman.app/track.html</loc></url><url><loc>https://helpman.app/auth.html</loc></url><url><loc>https://helpman.app/terms.html</loc></url><url><loc>https://helpman.app/privacy.html</loc></url></urlset>',encoding="utf-8")
(ROOT/"public/site.webmanifest").write_text('{"name":"Helpman","short_name":"Helpman","start_url":"/","display":"standalone","background_color":"#ffffff","theme_color":"#102033","description":"Home projects, handled."}',encoding="utf-8")

print("Helpman V2 patch applied.")
print("Run npm test, inspect the generated *.pre-helpman-v2 backups, then remove backup files before committing.")
