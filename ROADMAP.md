# ROADMAP.md — General Handyman Solutions

Ordered by business value. Stubs in v1 are marked honestly in the README;
each item below turns one into the real thing.

## 1. Real payments with Stripe — DONE (2026-10-04)
**Today:** `GET /api/payments/stripe-status` returns `{implemented:true}`;
payments are manual bookkeeping rows.
**Plan:**
- Server: add `stripe` SDK, `POST /api/payments/intent` creates a
  PaymentIntent for the quote deposit (amount = `deposit_cents`, metadata =
  project/quote ids). Webhook `POST /api/payments/webhook` verifies the
  Stripe signature and flips the payment row to `paid` / records failures.
- Client: Stripe.js on the customer portal "Pay deposit" step; never touches
  raw card numbers.
- Keep the `provider` column: `manual` rows remain valid for cash/check jobs.
- Env: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`.

## 2. SMS notifications (Twilio)
Booking confirmations, "contractor on the way", milestone approvals. Same
pluggable pattern as the mailer: `sms.js` provider with console log mode,
real delivery via Twilio when `TWILIO_*` keys are set. Segments already exist;
campaigns gain a channel field (`email`/`sms`).

## 3. Spanish i18n
UI in English today (US market default). Add a lightweight dictionary +
`?lang=es` switch, starting with the public intake flow — a large share of
the addressable market prefers Spanish. Backend messages stay English;
customer-facing strings move to `public/js/i18n/`.

## 4. Mobile app (contractors)
Contractors do everything on phones. Options: (a) PWA wrapper around the
contractor portal (offline photo queue, push via web-push); (b) React Native
later. The API is already token-based and mobile-ready, so (a) is weeks, not
months.

## 5. Estimation engine v2 (calibration loop)
`reports/calibration` already measures estimate-vs-actual. Feed it back:
per-trade adjustment factors learned from completed projects, with a manual
"apply" step so pricing stays explainable and human-approved.

## 6. Contractor payouts & 1099s
Track contractor payables per project, payout schedule, and year-end totals
for 1099-NEC reporting. Builds on the existing `contractor_cost_cents`.

## 7. Scheduling & dispatch
Calendar view for admin, contractor availability windows, automated
assignment suggestions (trade match + radius + rating + workload).

## 8. Multi-market expansion
Per-market labor multipliers already exist in the engine (`state` field);
add market admin (service areas, pricing overrides) and Spanish-first landing
variants.

## 9. In-app messaging — ✅ IMPLEMENTED (mediated model, business rule)
**Was:** real-time chat second, email notifications first.
**Now:** two mediated threads per project (`client_support`, `support_contractor`);
customers and contractors can only see/write their own thread with support —
**no direct client↔contractor contact is possible** (enforced server-side).
Every message emails the other side through the mailer (console/log mode until
a provider is set). UI in customer, contractor and admin portals; admin can
switch between both sides. Audit-safe, covered by `npm test`.

Next step (optional): WebSocket push for real-time delivery; the polling
fallback (15 s in the current UI) stays.

## Non-goals (deliberate)
- No marketplace bidding: the platform sets the price (managed model).
- No native consumer app until the web funnel converts — mobile web first.
