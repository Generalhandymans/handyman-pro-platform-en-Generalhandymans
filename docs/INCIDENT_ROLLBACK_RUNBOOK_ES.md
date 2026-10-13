# HELPMAN Incident & Rollback Runbook

## Severity
- SEV-1: payments, auth, database loss/unavailable, cross-user data exposure.
- SEV-2: intake/quote/project flow materially broken.
- SEV-3: degraded non-critical feature, AI provider failure with fallback working.

## Immediate actions
1. Stop auto-deploy.
2. Record current release SHA and incident time.
3. For suspected security/data exposure: disable affected endpoint or service immediately.
4. For payment issue: stop new payment actions if ledger correctness is uncertain.
5. For DB issue: do not run destructive repair against production without snapshot.
6. Use health/readiness and logs to isolate application vs DB/provider.

## Rollback
- Application-only regression: deploy previous known-good SHA.
- DB migration regression: prefer forward fix; restore only if data integrity demands it.
- Before restore: preserve current broken DB snapshot for forensic comparison.

## AI outage
AI must degrade to heuristic/fallback.
Do not take the full intake flow offline because OpenAI/provider is unavailable.

## Email outage
Keep actions persisted; surface delivery failure.
Do not claim email was delivered if provider did not confirm.

## Stripe outage
Do not mark payment paid without verified webhook/provider state.
Allow operations team to see failed/pending state.

## Postmortem
Document:
- impact window
- customer/project impact
- root cause
- detection gap
- remediation
- owner
- follow-up deadline
