# ARCHITECTURE.md — Handyman Pro

## System diagram (text)

```
                    ┌─────────────────────────────────────────┐
                    │              BROWSER (vanilla JS)         │
                    │  index  auth  track  customer            │
                    │  contractor  admin        (public/)      │
                    └───────────────┬─────────────────────────┘
                                    │  HTTPS/JSON + multipart
                                    ▼
                    ┌─────────────────────────────────────────┐
                    │         Express (server.js, :3000)       │
                    │  static public/  │  /api/*  │  /api/     │
                    │                  │  routes  │  photos/   │
                    │                  │          │  :filename  │
                    └───────────────┬─────────────────────────┘
                                    │
            ┌───────────────────────┼───────────────────────┐
            ▼                       ▼                       ▼
   ┌────────────────┐    ┌──────────────────┐    ┌──────────────────┐
   │  better-sqlite3│    │  services/       │    │  outbox worker   │
   │  ONE .db file  │    │  estimator  (pure│    │  (setInterval    │
   │  WAL mode, FK  │    │   deterministic) │    │   30s, drains    │
   │  data/         │    │  vision (fetch→   │    │   email_outbox → │
   │  handyman.db   │    │   OpenAI or       │    │   mailer →       │
   └────────────────┘    │   heuristic)      │    │   email_log)     │
                         │  mailer (console/ │    └──────────────────┘
                         │   SendGrid)       │
                         │  crm (scores,     │
                         │   tasks, segments)│
                         └──────────────────┘
```

## Key decisions and why

**1. One SQLite file (better-sqlite3), no separate DB server.**
This is a single-business operational tool, not a multi-tenant SaaS. SQLite
gives zero-ops deployment (`npm install && npm start`), ACID transactions
(quote-accept spins up project + milestones + deposit atomically), and WAL mode
for concurrent reads. If the business outgrows it, the SQL is portable to
Postgres.

**2. Synchronous DB driver.**
better-sqlite3 is synchronous, which keeps route code linear and readable —
no promise chains around every query, no forgotten awaits. Fine at this scale.

**3. Money in integer cents.**
Floats corrupt money. Every price column is `_cents` INTEGER; formatting to
`$X.XX` happens only at display time (frontend `fmtMoney`).

**4. Deterministic estimation engine (the core IP).**
`src/services/estimator.js` is a pure function: same inputs → same outputs,
versioned (`engine_version`). It composes: trade base range → scalable scope
drivers (e.g. $/sqft) → option multipliers → urgency ×1.25 → US-state labor
multiplier → risk contingencies that widen only the high end → confidence
0–95 → human-readable `factors` explaining what moved the price. No LLM in the
pricing path: pricing must be explainable and reproducible.

**5. Vision as a provider hook, honest fallback.**
`src/services/vision.js` defines a tiny provider interface. With
`OPENAI_API_KEY` it calls a vision model via native fetch; without a key it
returns a documented heuristic result (metadata + "looks like a room" hint)
and labels itself. The API never fakes an AI analysis.

**6. Pluggable mailer, log mode by default.**
`src/services/mailer.js` sends via console-log or SendGrid. Every attempt —
real or logged — lands in `email_log`, so campaigns are auditable before any
money is spent on email. The sender is the business identity
(`HANDYMAN_FROM_EMAIL`), configured once, never a personal address.

**7. JWT roles, dual signup, guest claim tokens.**
`customer` / `contractor` / `admin` roles enforced by middleware on every
protected route. Guests can request a job without an account and track it with
an unguessable `claim_token` (32 hex chars), which lowers the B2C conversion
friction on mobile.

**8. Managed-marketplace money flow in the data model.**
`quotes` store both `customer_price_cents` and `contractor_cost_cents` — the
platform spread is explicit, and `reports/margins` shows projected vs actual
margin per project. Payments are bookkeeping rows (`provider="manual"`);
Stripe is a documented stub, never a fake button.

**9. Two-sided CRM.**
Clients: lead → quote → project → review → referral, with a computed lead
score and follow-up task rules. Contractors: applicant → verification
(license, insurance, background check with activation guardrails) → active →
performance/retention scoring. Campaign segments exist per side.

**10. No build step.**
Vanilla HTML/CSS/JS. The whole app is readable and debuggable by the owner
without a toolchain, and deploys anywhere Node runs.

## Request lifecycle

```
guest/customer → POST /api/jobs (+photos, +estimate) → admin creates quote →
quote sent → customer accepts → project + milestones + deposit row (one tx) →
admin assigns contractor → contractor moves stages, completes milestones,
uploads progress photos → customer approves milestones → completed →
customer reviews → referral code
```

## Security notes

- bcryptjs (pure JS) password hashing, cost 10. No native build needed.
- JWT 7-day expiry, secret from env (dev fallback warns by being obviously
  named `dev-only-secret-change-me`).
- Input validation on every write endpoint; 422 `{errors:{field:msg}}`.
- Multer: 5 MB/file, images only, 6 files max; friendly error mapping.
- Photos served by DB-checked `/api/photos/:filename`, never raw static.
- `.env`, `*.db*`, `uploads/` git-ignored.
