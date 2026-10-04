# Handyman Pro — Managed Marketplace Platform

B2C home-services business platform: the platform quotes the customer, collects a
deposit, assigns a vetted contractor, and keeps the margin. Full-stack rebuild
with a real estimation engine, two-sided CRM (clients + contractors), mass email
campaigns, and reports computed live from the database.

**Brand:** Handyman Pro. All platform email goes out from the business account —
never a personal one (see "Business email setup").

## Run it

Requirements: Node.js 18+ (tested on Node 24).

```bash
npm install
npm start
```

Open http://localhost:3000

On first boot with an empty database, the server automatically loads demo seed
data (`src/seed.js` refuses to run twice, so this is safe). To re-seed from
scratch: delete `data/handyman.db*` and restart.

No build tools, no bundlers, no frontend frameworks — vanilla HTML/CSS/JS served
by Express, one SQLite file.

## Demo logins (seed data)

| Role       | Email                      | Password       |
|------------|----------------------------|----------------|
| Admin      | admin@handymanpro.test     | Admin123!      |
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
| `HANDYMAN_FROM_NAME`  | `Handyman Pro`             | Business sender display name |
| `EMAIL_PROVIDER`      | `console`                  | `console` (log mode) or `sendgrid` |
| `SENDGRID_API_KEY`    | —                          | Required for real delivery via SendGrid |
| `OPENAI_API_KEY`      | —                          | Optional: enables AI photo analysis |
| `OPENAI_VISION_MODEL` | `gpt-4o-mini`              | Vision model when a key is set |

## Business email setup

All CRM campaigns and notifications are sent **from the business account**
(`HANDYMAN_FROM_EMAIL`, default `generalhandymans@gmail.com`, name
"Handyman Pro") — never from a personal address.

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
  middleware, bcrypt passwords.
- Job request intake with photo upload (5 MB max, images only, 6 max).
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
- **Payments (Stripe): NOT integrated.** `GET /api/payments/stripe-status`
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
git remote add origin https://github.com/Generalhandymans/handyman-pro-platform.git
git branch -M main
git push -u origin main
```

(Replace `handyman-pro-platform` if you create the repo under a different name
on GitHub first — create the empty repo on github.com/Generalhandymans, then
run the commands above.)

`.gitignore` already excludes `node_modules/`, `.env`, `*.db*`, and `uploads/`
— secrets and customer data never get committed.

## Project layout

```
server.js            Express app, static frontend, outbox worker
src/db.js            SQLite schema (one .db file, WAL mode)
src/middleware/      JWT auth, role checks, input validators
src/services/        estimator.js (real engine), vision.js, mailer.js, crm.js
src/routes/          REST API (auth, jobs, quotes, projects, contractors,
                     crm, campaigns, reports, reviews, referrals, payments)
src/seed.js          Coherent demo data (idempotent)
public/              Vanilla frontend: index, auth, track, customer,
                     contractor, admin
```

Docs: `ARCHITECTURE.md` (design decisions), `API.md` (endpoints),
`ROADMAP.md` (what's next: Stripe, mobile app, Spanish i18n, SMS).
