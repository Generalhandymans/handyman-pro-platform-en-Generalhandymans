# General Handyman Solutions — Production V2 Upgrade Pack

This package is designed to be applied to the existing repository:

`Generalhandymans/handyman-pro-platform-en-Generalhandymans`

It does **not** replace the existing business logic. It upgrades the platform around it so the system can evolve from an advanced MVP into a production-grade managed home-services marketplace.

## Target architecture

Browser / PWA
→ HTTPS
→ Express API
→ PostgreSQL
→ Object storage (S3 / Cloudflare R2 compatible)
→ Stripe
→ Email provider
→ AI orchestration
→ Dispatch / matching
→ Observability

## What this upgrade adds

- PostgreSQL production schema and migration structure
- S3/R2 private media storage with signed URLs
- Authorization-first photo/media access model
- Security middleware and production headers
- Cookie-session migration strategy (away from raw localStorage JWT)
- Contractor matching engine with explainable scoring
- AI operations copilot with recommendations rather than uncontrolled pricing
- Dispatch board data model
- Contractor payouts / payable ledger
- Stripe webhook idempotency schema
- Revenue/GMV/cash/payout financial separation
- Structured logging + operational health endpoint
- Modern operations dashboard starter
- Production deployment checklist
- Security checklist
- Test expansion plan

## Important

The connected GitHub account available to ChatGPT had read-only permission on the target repository, so this package was generated without modifying the original repository.

Before deploying:
1. Apply the migration.
2. Configure environment variables.
3. Wire the V2 routes into `server.js`.
4. Replace local photo storage with the storage service.
5. Move the existing SQLite data to PostgreSQL.
6. Run full regression tests.
7. Configure Stripe, email, storage, monitoring and backups.
