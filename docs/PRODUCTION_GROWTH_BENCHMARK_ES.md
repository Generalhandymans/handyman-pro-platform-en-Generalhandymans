# HELPMAN — Fase 6: Production, Growth & Launch Readiness

## Referencias actuales del rubro

### Jobber
- Online booking ligado a disponibilidad.
- Client Hub mobile-first para quotes, appointments y pagos.
- Review asks automatizados al completar trabajo.
- Formularios de booking embebibles en web/social.
- Tracking de Google Business Profile / Analytics.

### Housecall Pro
- Online Booking conectado a Google, web y links.
- Marketing Center con ROI por lead source.
- Review management automatizado.
- SEO local: XML sitemap, LocalBusiness schema, mobile optimization, page speed, redirects.
- Search Console + Analytics.

### ServiceTitan
- Operación y marketing conectados.
- Dispatch / CRM / revenue attribution como sistema único.

## Diseño final HELPMAN

La fase 6 no agrega otro gran módulo de negocio. Cierra el sistema para producción:

1. Production readiness
2. PostgreSQL como DB de producción
3. Readiness / liveness checks
4. Observability
5. Backups / restore drills
6. Error / incident runbook
7. SEO local programático responsable
8. Service + city landing-page framework
9. LocalBusiness / Service structured data
10. PWA/mobile shell
11. Analytics / attribution
12. Review/referral growth loop
13. Notification center
14. Accessibility baseline
15. Performance budgets
16. E2E release QA
17. Deployment checklist
18. Rollback plan
19. Post-launch monitoring

## Growth Loop HELPMAN

Search / Ads / Referral / GBP
→ Request
→ Scope / Estimate
→ Booking / Quote
→ Project
→ Payment
→ Review
→ Referral
→ Repeat project

## Principios SEO

- No crear miles de páginas thin/spam.
- Solo publicar city/service pages si existe cobertura real.
- Copy único, útil y verificable.
- No fingir oficina física en ciudades donde no existe.
- Usar service-area business model.
- Structured data debe reflejar información real.
- Reviews visibles deben provenir de reviews reales.
- No generar claims de “best”, “#1”, “licensed everywhere” sin respaldo.

## Principios de producción

- PostgreSQL obligatorio para producción.
- No usar SQLite efímero en Render.
- SEED_DEMO=false.
- JWT_SECRET fuerte.
- EMAIL_PROVIDER real antes de depender de notificaciones.
- Stripe webhook probado.
- OPENAI failure no debe tumbar intake.
- S3/object storage recomendado para fotos.
- Backups probados mediante restore.
- Monitoring debe detectar error rate, latency, DB, payment failures y queue backlog.
