# Security Review — V2

## Existing strengths
- bcrypt password hashing
- JWT role enforcement
- password reset does not reveal account existence
- signed Stripe webhooks
- upload size limits
- deterministic role-based messaging access
- admin audit events
- rate limiting on authentication and intake

## Required changes
1. Do not treat an unguessable image filename as authorization.
2. Move private media to object storage and authorize each read.
3. Replace or reduce exposure of long-lived bearer tokens in `localStorage`.
4. Add Content Security Policy and standard security headers.
5. Hash verification/reset tokens at rest instead of storing raw tokens.
6. Add server-side token/session revocation strategy.
7. Add sensitive-field log redaction.
8. Add Stripe event idempotency and reconciliation.
9. Add dependency vulnerability scanning in CI.
10. Add role/authorization matrix tests for every protected entity.
11. Add login lockout/risk controls beyond only IP-based throttling.
12. Review contractor/customer PII retention and deletion rules.
