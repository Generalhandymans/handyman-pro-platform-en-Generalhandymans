# Production Checklist

## P0 — must be complete before real customers
- [ ] PostgreSQL deployed with automated backups and PITR where available
- [ ] Existing SQLite data migrated and reconciled
- [ ] Private media moved from local disk to S3/R2
- [ ] Photo/document authorization enforced before signed URL generation
- [ ] Production JWT secret rotated and stored in secret manager
- [ ] Auth token migration away from long-lived localStorage bearer token
- [ ] HTTPS enforced
- [ ] Security headers enabled
- [ ] Stripe live keys configured
- [ ] Stripe webhook idempotency implemented with `stripe_events`
- [ ] Duplicate PaymentIntent prevention tested under concurrency
- [ ] Refund and chargeback workflows defined
- [ ] Email sender domain authenticated (SPF/DKIM/DMARC)
- [ ] Database, storage and Stripe reconciliation monitoring enabled
- [ ] Terms/Privacy reviewed by counsel for actual operating model
- [ ] Contractor license/insurance verification process documented
- [ ] Error monitoring configured
- [ ] Daily backups tested by performing a restore
- [ ] Production smoke tests passing

## P1 — launch-quality operations
- [ ] Dispatch recommendation endpoint
- [ ] Contractor availability
- [ ] Calendar/day/week dispatch board
- [ ] Contractor payable ledger
- [ ] Manual payout approval
- [ ] W-9 collection workflow
- [ ] License/insurance expiration alerts
- [ ] AI recommendation center
- [ ] Quote follow-up automation
- [ ] Failed-payment queue
- [ ] Customer support SLA dashboard
- [ ] Spanish public intake flow
- [ ] PWA contractor experience

## P2 — scale
- [ ] Background queue service instead of in-process interval worker
- [ ] Redis for distributed rate limit / queue coordination if horizontally scaled
- [ ] Read replica / analytics warehouse when required
- [ ] Advanced routing and territory optimization
- [ ] Automated estimate calibration with human approval
- [ ] Multi-market configuration
