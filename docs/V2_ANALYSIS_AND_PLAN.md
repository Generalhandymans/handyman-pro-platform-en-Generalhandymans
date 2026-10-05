# V2 Package — Análisis técnico completo y plan de integración

Fecha: 5-oct-2026. Análisis ejecutado por Cooper (Muse) a pedido de Armando.

## 1. Qué es el paquete

Overlay de 35 archivos (~96 KB) generado por ChatGPT. **No es un reemplazo**: ningún
archivo existente es sobrescrito. Todo son rutas nuevas (`*-v2.html`, `src/db/postgres.js`, etc.).

## 2. Pruebas ejecutadas

| Módulo | Resultado |
|---|---|
| `src/services/matching.js` | ✅ Funciona. Ranking correcto; contratistas sin licencia/seguro son **filtrados** (no solo penalizados). Diseño correcto. |
| `src/services/financials.js` | ✅ Cálculos correctos (GMV, cash collected, margen bruto 33.3%, contribución realizada). |
| `src/services/ai/ops-copilot.js` | ✅ Funciona, pero **no es IA**: son reglas if/else (cotización >48h → seguimiento, margen <20% → alerta). Sin llamadas a ningún modelo. |
| `src/config/env.js` | ✅ Valida bien: exige DATABASE_URL/JWT/PUBLIC_URL en producción, JWT ≥48 chars, HTTPS obligatorio. |
| `src/services/storage.js` | ⚠️ No probado: requiere `@aws-sdk/*` + bucket S3/R2 configurado. El formato de `objectKey()` es correcto. |
| `src/db/postgres.js` | ⚠️ No probado: requiere PostgreSQL en vivo. El pool está bien configurado. |
| `src/db/migrations/001_v2_production.sql` | ⚠️ **Incompleta**: 14 tablas, pero **faltan 10 tablas del esquema actual**: `terms_acceptances` (prueba legal), `message_threads`, `messages`, `referrals`, `campaigns`, `email_outbox`, `email_log`, `reviews`, `interactions`, `followup_tasks`. Migrar así = pérdida de datos. |
| `src/middleware/security-v2.js` | ✅ Correcto (helmet CSP con Stripe permitido, request-id, no-store en auth/pagos). No integrado. |
| `src/observability/logger.js` | ✅ Correcto (pino con redacción de secretos). No integrado. |
| `src/routes/dispatch-v2.js` | ⚠️ Asume `req.user` pero **no incluye middleware de auth** — si se conecta sin auth, queda abierto. |
| `src/routes/media-v2.js` | ⚠️ Igual: sin auth propia; además referencia tabla `media_objects` que solo existe en la migración. |
| `src/routes/health-v2.js` | ✅ Correcto. |
| Páginas `*-v2.html` (7) | ✅ Renderizan bien (verificadas en preview). Son **maquetas estáticas**: no llaman a la API actual. |
| Docs (5) | ✅ El `SECURITY_REVIEW.md` es honesto y útil; varios puntos aplican a la app actual. |

## 3. Problemas encontrados

1. **Migración SQL incompleta** (10 tablas faltantes) — bloqueante para cualquier migración real.
2. **Rutas v2 sin autenticación propia** — `dispatch-v2.js`, `media-v2.js` confían en middleware externo no incluido.
3. **Nada está conectado**: `server-v2-integration.js` es solo una guía, no hay wiring real.
4. **"AI Copilot" no es IA**: reglas deterministas + recomendaciones hardcodeadas en el HTML del admin.
5. **Requiere infraestructura nueva**: PostgreSQL, bucket S3/R2, 5 dependencias npm (`pg`, `helmet`, `pino`, `@aws-sdk/*`).

## 4. Plan de integración recomendado (cherry-pick, no big-bang)

### Fase 1 — Sin infraestructura nueva (SQLite actual, plan gratis)
1. **Matching engine** → integrarlo al flujo `POST /api/projects/:id/assign`: sugerir top-3 contratistas al admin. Es puro JS, funciona con SQLite hoy.
2. **Security headers + logger** → `helmet` y `pino` en `server.js` (2 dependencias livianas, sin riesgo).
3. **Rediseño visual V2** → portar el CSS/páginas v2 a las páginas actuales (ya con la marca real aplicada en esta rama).

### Fase 2 — Cuando haya plan de pago en Render
4. **PostgreSQL**: completar la migración (agregar las 10 tablas faltantes), probar migración de datos SQLite→PG, luego cambiar.
5. **S3/R2**: mover fotos de `uploads/` a storage privado con URLs firmadas.

### Fase 3 — Cuando haya volumen real
6. **Dispatch board** y **financials dashboard** conectados a datos reales.
7. **Copilot con IA real** (OpenAI) para resúmenes y detección de riesgos — las reglas actuales sirven como base.

## 5. Qué NO hacer

- No hacer merge de esta rama a `main` tal cual está.
- No migrar a PostgreSQL con el SQL actual (incompleto).
- No exponer las rutas v2 sin auth.
- No presentar el "AI Copilot" como IA real a nadie.
