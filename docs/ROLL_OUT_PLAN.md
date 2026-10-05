# Rollout Plan

## Phase 1 — Foundation
- Introduce PostgreSQL behind a compatibility data-access layer.
- Add migration scripts.
- Move media to S3/R2.
- Add security headers and structured logging.
- Keep existing UI and business flows working.

## Phase 2 — Operations
- Add dispatch recommendation endpoint.
- Add contractor availability + service geography.
- Add payables and payout workflow.
- Separate GMV, collected cash, refunds, fees, payable and margin reporting.

## Phase 3 — AI
- Lead prioritization.
- Quote follow-up recommendations.
- Dispatch recommendations.
- Margin-risk recommendations.
- Project-delay detection.
- AI never executes irreversible actions without policy or explicit approval.

## Phase 4 — Experience
- Replace current admin tab layout with Operations Command Center.
- Add calendar/dispatch board.
- Upgrade public landing and request wizard.
- Build contractor PWA.
- Add Spanish localization.

## Phase 5 — Scale
- External background job queue.
- Horizontal app replicas.
- Redis/distributed rate limiting as needed.
- BI/warehouse if operational reporting becomes heavy.
