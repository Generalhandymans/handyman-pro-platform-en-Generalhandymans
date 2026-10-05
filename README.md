# General Handyman Solutions — Managed Marketplace Platform

B2C home-services business platform: the platform quotes the customer, collects a
deposit, assigns a vetted contractor, and keeps the margin. Full-stack rebuild
with a real estimation engine, two-sided CRM (clients + contractors), mass email
campaigns, and reports computed live from the database.

**Brand:** General Handyman Solutions. All platform email goes out from the business account —
never a personal one (see "Business email setup").

## Run it

Requirements: Node.js 18+ (tested on Node 24).

```bash
npm install
npm start
```

Open http://localhost:3000

On first boot with an empty database:
- **Production:** set `ADMIN_EMAIL` + `ADMIN_PASSWORD` (and optional `ADMIN_NAME`)
  in your environment — the server creates that admin and nothing else.
- **Demo/dev:** set `SEED_DEMO=true` to load the demo dataset explicitly.
- **Neither:** the server boots with an empty database and warns. Demo accounts
  are NEVER created silently.

To re-seed from scratch: delete `data/handyman.db*` and restart with `SEED_DEMO=true`.

No build tools, no bundlers, no frontend frameworks — vanilla HTML/CSS/JS served
by Express, one SQLite file.

## Demo logins (seed data — only when `SEED_DEMO=true`)

| Role       | Email                      | Password       |
|------------|----------------------------|----------------|
| Admin      | admin@generalhandymansolutions.test     | Admin123!      |
| Customer   | maya.t@example.com         | Customer123!   |
| Contractor | carlos.m@example.com       | Contractor123! |

## Environment variables

Copy `.env.example` to `.env` and adjust:

| Variable              | Default                    | What it does |
|-----------------------|----------------------------|--------------|
| `PORT`                | `3000`                     | HTTP port |
| `JWT_SECRET`          | (dev fallback)             | **Set a long random value in production.** Tokens are invalid without it. |
| `DB_PATH`             | `./data/handyman.db`       | SQLite file location |
| `HANDYMAN_FROM_EMAIL` | `generalhandymans@gmail.com` | **Business sender address** — every platform email is sent from here |
| `HANDYMAN_FROM_NAME`  | `General Handyman Solutions`             | Business sender display name |
| `EMAIL_PROVIDER`      | `console`                  | `console` (log mode) or `sendgrid` |
| `SENDGRID_API_KEY`    | —                          | Required for real delivery via SendGrid |
| `OPENAI_API_KEY`      | —                          | Optional: enables AI photo analysis |
| `OPENAI_VISION_MODEL` | `gpt-4o-mini`              | Vision model when a key is set |

## Business email setup

All CRM campaigns and notifications are sent **from the business account**
(`HANDYMAN_FROM_EMAIL`, default `generalhandymans@gmail.com`, name
"General Handyman Solutions") — never from a personal address.

Out of the box the mailer runs in **log mode** (`EMAIL_PROVIDER=console`):
messages are printed to the server console **and** recorded in the `email_log`
table, so campaigns are fully testable and auditable without sending anything
real. The admin dashboard shows the active provider and sender.

To send real email:

1. Set `EMAIL_PROVIDER=sendgrid` and `SENDGRID_API_KEY` (a key authorized to
   send from `generalhandymans@gmail.com` — verify that sender identity in
   SendGrid first).
2. Restart the server and confirm the dashboard badge shows `sendgrid`.
3. Send a test campaign to yourself before emailing customers.

## What works for real vs. what's a stub (honest list)

**Works for real:**
- Dual registration + login (customer / contractor), JWT sessions, role
  middleware, bcrypt passwords. **Email verification** (`/auth/verify`,
  resend available) and **password recovery** (forgot/reset with expiring
  token) — emails go through the mailer (log mode until a provider is set).
- Rate limiting on public endpoints: auth (20/15 min) and job creation
  (30/hour).
- Job request intake with photo upload (5 MB max, images only, 6 max).
  **Photos are optimized on upload with `sharp`**: resized so the longest
  side is ≤ 1600 px and recompressed (JPEG/WebP quality ~80); the optimized
  file is what gets served.
- Mediated messaging (**business rule: NO direct client↔contractor contact**).
  Two thread kinds per project — `client_support` (customer ↔ support) and
  `support_contractor` (support ↔ contractor). Customers only see/write the
  first, contractors only the second, admin sees both. Every message triggers
  an email notification to the other side (support for customers/contractors,
  the relevant party for admin replies).
- Automatic email notifications on every state change: quote sent, quote
  accepted, contractor assigned, milestone completed, milestone approved,
  project completed. All recorded in `email_log` (console mode = logged,
  not really sent).
- Project scheduling: admin sets `scheduled_start`/`scheduled_end`
  (UI + `PATCH /api/projects/:id/schedule`, validated: end ≥ start).
- Admin audit log (`admin_audit` table + overview panel): quote creation /
  sending, contractor assignment, milestone completion / approval, campaign
  sends, contractor verification, scheduling.
- `npm test` — 11 automated end-to-end tests (node:test) covering dual
  signup, login, verification, password recovery, job intake + optimized
  photo upload, estimate, quote→send→accept→project, assignment, **mediated
  messaging (including 403s when a customer tries the contractor thread)**,
  milestone notifications, scheduling validation, audit trail, rate-limit
  headers.
- Deterministic estimation engine: 8 trades, base ranges, scope drivers,
  urgency ×1.25, US-state labor multipliers, risk contingencies, confidence
  score, explainable price factors. Re-running the same inputs gives the same
  result.
- Photo vision hook: with `OPENAI_API_KEY` it calls a vision model; without a
  key it runs a documented heuristic mode (metadata + room hint) and says so.
- Quotes → customer accept spins up a project with milestones + deposit
  bookkeeping, all in one transaction.
- Project tracking, milestone completion + customer approval, progress photos,
  reviews, referrals/coupons.
- Two-sided CRM: client pipeline with lead scores, follow-up task generator
  (e.g. quote sent 48 h with no response), contractor lifecycle + verification
  workflow with activation guardrails, segmented campaigns with templates,
  outbox queue + background sender, full `email_log`.
- Reports 100% computed from the DB: overview KPIs, client funnel,
  contractor funnel, projected-vs-actual margins, avg ticket by trade/month,
  contractor performance, estimate-vs-actual calibration.

**Stubs / not implemented:**
- **Payments (Stripe): READY.** `GET /api/payments/stripe-status` — set `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` to charge cards; without them, deposits stay manual.
  returns `{implemented:false}`. All payment rows are manual bookkeeping
  (`provider="manual"`) — nothing charges a card. See ROADMAP.md.
- **Vision AI without a key:** heuristic mode only, clearly labeled.
- **Email without a provider key:** log mode only, clearly labeled.

## GitHub (business account: Generalhandymans)

This repo is initialized with git and committed, but **no remote is configured
and nothing has been pushed** (no credentials on this machine). The business
GitHub account is **Generalhandymans**. To connect and push:

```bash
cd handyman-platform
git remote add origin https://github.com/Generalhandymans/general-handyman-solutions-platform.git
git branch -M main
git push -u origin main
```

(Replace `general-handyman-solutions-platform` if you create the repo under a different name
on GitHub first — create the empty repo on github.com/Generalhandymans, then
run the commands above.)

`.gitignore` already excludes `node_modules/`, `.env`, `*.db*`, and `uploads/`
— secrets and customer data never get committed.

## Project layout

```
server.js            Express app, static frontend, outbox worker
src/db.js            SQLite schema (one .db file, WAL mode)
src/middleware/      JWT auth, role checks, input validators
src/services/        estimator.js (real engine), vision.js, mailer.js, crm.js,
                     notify.js (state-change emails), photos.js (sharp optimize),
                     audit.js (admin audit log)
src/routes/          REST API (auth, jobs, quotes, projects, contractors,
                     crm, campaigns, reports, reviews, referrals, payments,
                     messages)
src/seed.js          Coherent demo data (idempotent)
test/api.test.js     11 end-to-end tests (node:test) — run with `npm test`
public/              Vanilla frontend: index, auth, track, customer,
                     contractor, admin (+ shared js/messages.js component)
```

Docs: `ARCHITECTURE.md` (design decisions), `API.md` (endpoints),
`ROADMAP.md` (what's next: Stripe, mobile app, Spanish i18n, SMS).
