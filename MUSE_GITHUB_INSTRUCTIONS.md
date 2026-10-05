# Muse — GitHub Integration Instructions

Target repository:

`Generalhandymans/handyman-pro-platform-en-Generalhandymans`

## Goal

Integrate the V2 upgrade into the existing General Handyman Solutions repository **without deleting the current working version**.

## Required Git workflow

1. Clone the existing repository.
2. Create a new branch:

```bash
git checkout -b v2-production-upgrade
```

3. Copy the contents of this package into the repository root.
4. Do **not** delete the existing application files unless the new V2 file explicitly replaces them.
5. Keep the original production/demo code intact while V2 is tested.
6. Install the additional dependencies listed in `package-v2.additions.json`.
7. Commit the V2 package:

```bash
git add .
git commit -m "feat: add General Handyman Production V2 upgrade"
git push origin v2-production-upgrade
```

8. Open a pull request from:

`v2-production-upgrade` → `main`

9. Do not merge until:
   - tests pass;
   - PostgreSQL is configured;
   - object storage is configured;
   - Stripe is configured;
   - security review is completed;
   - the V2 pages are tested on mobile and desktop.

## Visual files

Primary V2 screens:

- `public/index-v2.html`
- `public/auth-v2.html`
- `public/customer-v2.html`
- `public/contractor-v2.html`
- `public/project-detail-v2.html`
- `public/dispatch-board-v2.html`
- `public/admin-v2.html`
- `public/css/app-v2.css`
- `public/css/admin-v2.css`

Do not overwrite the current pages immediately. First serve the V2 screens side-by-side and validate them.

## Backend V2 files

- `src/config/env.js`
- `src/db/postgres.js`
- `src/db/migrations/001_v2_production.sql`
- `src/services/storage.js`
- `src/services/matching.js`
- `src/services/financials.js`
- `src/services/ai/ops-copilot.js`
- `src/middleware/security-v2.js`
- `src/routes/media-v2.js`
- `src/routes/dispatch-v2.js`
- `src/routes/health-v2.js`
- `src/observability/logger.js`
- `src/server-v2-integration.js`

## Recommended integration order

1. Security + observability
2. PostgreSQL
3. Media storage / signed URLs
4. Financial reporting semantics
5. Stripe event idempotency
6. Contractor matching
7. Dispatch
8. AI recommendations
9. Visual V2 screens
10. Contractor PWA and Spanish localization

## Important constraints

- Do not commit `.env`.
- Do not commit database dumps containing real customer data.
- Do not commit Stripe secret keys.
- Do not expose S3/R2 private media publicly.
- Do not remove the existing SQLite version until PostgreSQL migration is verified.
- Do not let AI autonomously charge cards, refund payments, alter prices, or assign contractors without an explicit approved action flow.
