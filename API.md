# API.md — Handyman Pro

Base: `http://localhost:3000`. JSON everywhere. Money is integer **cents**.
Auth: `Authorization: Bearer <JWT>` (7-day expiry). Roles: `customer`,
`contractor`, `admin`. Validation failures → `422 {errors:{field:message}}`.

Conventions: `GET /api/health` → `{ok, service, mail_provider, from}`.

## Auth — `/api/auth` (public)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/signup/customer` | `{name, email, phone?, password≥8}` | `{token, user}` 201 |
| POST | `/signup/contractor` | `{name, email, phone?, password, legal_name, city, service_base?, service_radius_miles?, years_experience?, specialties?, license_number?, insurance_info?}` | `{token, user, note}` — contractor starts `pending` |
| POST | `/login` | `{email, password}` | `{token, user}` |
| GET | `/me` 🔒 | — | user (+ `contractor` profile for contractors) |

## Trades — `/api/trades` (public)

| Method | Path | Returns |
|---|---|---|
| GET | `/` | `[{service_type, label}]` ×8 trades |
| GET | `/:type` | `{service_type, label, questions:[{key,label,type:number\|boolean\|select,required,min,max,options}]}` |

## Jobs — `/api/jobs`

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/` | public (token optional; attaches customer when present) | `{name, phone, email?, address, city, state, zip?, service_type, urgency?, description, scope?}` → 201 `{job…, claim_token}` |
| POST | `/:id/photos` | owner / admin / `?claim=` | multipart, field `photos` (≤6, ≤5MB, images) → runs vision hook |
| POST | `/:id/estimate` | owner / admin / `?claim=` | optional `{scope}` merge → **201 real estimate** `{low_cents, high_cents, line_items, missing, risks, confidence, factors, engine_version}` |
| GET | `/:id/estimate/latest` | owner / admin / `?claim=` | latest estimate or 404 |
| GET | `/:id` | owner / admin / `?claim=` | job + photos + latest estimate summary |
| GET | `/mine/list` | 🔒 customer | own requests |
| GET | `/` | 🔒 admin | `?status=` filter |
| PATCH | `/:id` | 🔒 admin | `{status}` pipeline move |

Guest access: append `?claim=<claim_token>` (returned at creation).

## Quotes — `/api/quotes`

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/` | 🔒 admin | `{job_request_id, customer_price_cents, contractor_cost_cents, deposit_pct?}` → 201 + `margin_cents`, `margin_note`. Rejects negative margin |
| POST | `/:id/send` | 🔒 admin | draft → sent; job → `quote_sent` |
| GET | `/` | 🔒 | `?job_request_id=` → quotes for a job (owner customer or admin) |
| GET | `/:id` | 🔒 | owner customer or admin |
| POST | `/:id/respond` | 🔒 | `{accept:true/false}`. Accept is transactional: quote→accepted, **project + trade milestones + deposit bookkeeping row created**, job → `deposit_paid`. Reject → job `lost` |

## Projects — `/api/projects` 🔒

| Method | Path | Notes |
|---|---|---|
| GET | `/` | role-scoped list (admin all / contractor assigned / customer own), each with milestones, photos, payments, contractor |
| GET | `/:id` | same detail for one project |
| POST | `/:id/assign` | 🔒 admin `{contractor_id}` — must be `active`; stage → `scheduled` |
| PATCH | `/:id/stage` | admin any of `assigned,scheduled,in_progress,review,completed,cancelled`; contractor only `scheduled,in_progress,review` |
| POST | `/:id/milestones/:mid/complete` | admin/contractor marks done |
| POST | `/:id/milestones/:mid/approve` | customer (or admin) `{approved:true/false}` |
| POST | `/:id/photos` | admin/contractor multipart `photos` + `kind=progress\|completion` |

## Contractors — `/api/contractors`

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/` | 🔒 admin | all, enriched with `lifecycle, score, retention_at_risk` |
| GET | `/me` | 🔒 contractor | own enriched profile |
| PATCH | `/me` | 🔒 contractor | editable: `city, service_base, service_radius_miles, years_experience, specialties, license_number, insurance_info` |
| PATCH | `/:id/verify` | 🔒 admin | `{license_verified, insurance_verified, background_check, status}` — **activation blocked** until license+insurance verified and background `passed` |
| GET | `/:id` | 🔒 admin | one enriched profile |

## CRM — `/api/crm` 🔒 admin

| Method | Path | Returns |
|---|---|---|
| GET | `/pipeline` | client stages: `[{status, count, value_cents, avg_lead_score}]` |
| GET | `/tasks` | follow-up tasks (`?status=`) |
| POST | `/tasks/generate` | runs rules (quote 48h no response, new request 24h no estimate, stalled project 14d) → `{created:n}` |
| PATCH | `/tasks/:id/done` | mark done |
| GET | `/contractors` | `{stages:{lifecycle:count}, contractors:[…]}` |
| GET | `/recruitment-gaps` | demand-vs-supply report by trade/city (planning data, not emails) |
| GET | `/email-log` | every send attempt, any provider |
| GET | `/segments/:name` | `{segment, count, sample}` preview for the campaign builder |

Segments: `all_customers, past_customers, inactive_clients_90d, lost_leads,
all_contractors, pending_contractors, top_contractors`.

## Campaigns — `/api/campaigns` 🔒 admin

| Method | Path | Notes |
|---|---|---|
| GET/POST | `/templates` | `{name, subject, body_html}` — `{{name}} {{company}}` variables |
| GET/POST | `/` | `{name, segment, template_id}` + recipient/sent counts |
| POST | `/:id/queue` | resolves segment → outbox rows (skips dupes) |
| POST | `/:id/send` | marks sending + flushes a batch now (worker drains rest every 30s) |
| GET | `/:id/outbox` | per-recipient status |

Sending is never fake: default `console` provider logs + records in
`email_log`; `sendgrid` delivers when configured.

## Reports — `/api/reports` 🔒 admin (all computed live from the DB)

| Path | Returns |
|---|---|
| `/overview` | KPIs: jobs, quotes sent/accepted + acceptance %, active/completed projects, revenue/cost/gross margin %, avg ticket, contractors active/pending, avg rating |
| `/funnel` | client funnel by job status + post-project reviews/referrals |
| `/contractor-funnel` | contractor lifecycle counts |
| `/margins` | per project: projected vs actual price and margin % |
| `/ticket` | avg ticket by service type and by month |
| `/contractors` | performance: jobs done/active, revenue, rating, lifecycle |
| `/calibration` | estimate-vs-actual: samples, % within range, avg deviation |

## Reviews / Referrals / Payments

- `POST /api/reviews` 🔒 `{project_id, rating 1-5, comment?}` — completed projects only, one per project; updates contractor `rating_avg`. `GET /api/reviews?contractor_id=`.
- `POST /api/referrals` 🔒 customer → `{code}` (HP-XXXXXX, 10% off). `GET /api/referrals/mine` 🔒. `POST /api/referrals/redeem` (public) `{code, email}`.
- `GET /api/payments/stripe-status` → `{implemented:false,…}` (honest stub).
  `GET /api/payments?project_id=` 🔒 role-scoped. `POST /api/payments` 🔒 admin
  `{project_id, kind:deposit|milestone|final|refund, amount_cents, notes?}` —
  manual bookkeeping only.

## Photos

`GET /api/photos/:filename` — serves the stored image with its real MIME type
(filename checked against the DB; 32-hex unguessable names).
