# HELPMAN — FINAL LAUNCH CHECKLIST

## P0 — No launch until all pass

### Database
- [ ] Production uses PostgreSQL (`DATABASE_URL`).
- [ ] SQLite is dev-only.
- [ ] All migrations 001–005 applied in staging and production.
- [ ] Backup job configured.
- [ ] Restore test completed successfully.

### Security
- [ ] JWT_SECRET >= 32 chars, unique to production.
- [ ] No demo accounts/data.
- [ ] Admin password rotated after first boot.
- [ ] Email verification flow tested.
- [ ] Forgot/reset tested.
- [ ] Stripe webhook signature verification tested.
- [ ] Upload MIME/size validation tested.
- [ ] IDOR tests for jobs/projects/photos/messages/change-orders.
- [ ] Rate limits tested.
- [ ] Security events visible.
- [ ] CSP migration completed or explicitly accepted as launch exception with owner/date.

### Money
- [ ] Stripe test mode full flow passes.
- [ ] Production keys installed.
- [ ] Deposit amount derived server-side.
- [ ] Webhook updates ledger.
- [ ] Failed payment appears in Operations Risk Center.
- [ ] Refund process documented.
- [ ] Contractor payout workflow documented.

### Email / Notifications
- [ ] Real provider enabled (not console).
- [ ] helpman.app sending domain authenticated.
- [ ] SPF/DKIM/DMARC configured.
- [ ] Verification email tested.
- [ ] Password reset tested.
- [ ] Quote/project/milestone messages tested.
- [ ] No legacy General Handyman Solutions sender branding unless legally intended.

### Customer journey
- [ ] request
- [ ] ZIP coverage
- [ ] photos
- [ ] smart scope
- [ ] estimate
- [ ] quote
- [ ] terms
- [ ] deposit
- [ ] project
- [ ] schedule
- [ ] messages
- [ ] milestones
- [ ] change order
- [ ] final payment
- [ ] review
- [ ] referral

### Contractor journey
- [ ] signup
- [ ] verification
- [ ] documents
- [ ] skills
- [ ] availability
- [ ] matching
- [ ] offer
- [ ] terms acceptance
- [ ] execution
- [ ] daily log
- [ ] photos
- [ ] milestone completion
- [ ] payout visibility

### Admin / Operations
- [ ] Control Center
- [ ] pipeline
- [ ] dispatch
- [ ] risk center
- [ ] contractor compliance
- [ ] payments
- [ ] messages
- [ ] campaigns
- [ ] audit log
- [ ] Intelligence Center
- [ ] Security Center
- [ ] Growth dashboard

## P1 — Launch-quality
- [ ] Core Web Vitals reviewed.
- [ ] Mobile QA: iPhone + Android viewport.
- [ ] Keyboard navigation.
- [ ] Contrast.
- [ ] Form labels/errors.
- [ ] Empty states.
- [ ] 404/500 UX.
- [ ] robots.txt.
- [ ] sitemap.
- [ ] canonical URLs.
- [ ] structured data validation.
- [ ] Google Search Console.
- [ ] GA4 / analytics.
- [ ] Google Business Profile.
- [ ] real review loop.
- [ ] service-area pages only for real coverage.

## Rollback
- [ ] Previous release SHA recorded.
- [ ] DB migration rollback/forward-fix strategy documented.
- [ ] Backup snapshot taken before deploy.
- [ ] Owner authorized to rollback identified.

## First 72 hours
Monitor:
- signup/login failures
- intake errors
- quote acceptance
- Stripe failures
- webhook failures
- email delivery
- API p95 latency
- 5xx rate
- DB connection errors
- AI fallback rate
- unassigned projects
- contractor offer response
