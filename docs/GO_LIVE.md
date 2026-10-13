# Puesta en marcha — lista de verificación

> Estado de partida: el código está escrito y se verificó en un entorno temporal (60 de 62 pruebas en un entorno temporal → ver `AUDIT_CHANGES.md`).
> **Nada de esto se ha ejecutado con tus dependencias reales, con PostgreSQL ni con servicios externos.**
> Esta lista es el camino desde ahí hasta un piloto con clientes reales. Marca cada punto.

## 0. Antes de empezar (cosas que solo tú puedes conseguir)
- [ ] **Dominio propio** para el correo (no `@gmail.com`: no se puede autenticar con SPF/DKIM/DMARC y el correo llegará a spam).
- [ ] Cuentas: **Render** (o tu host), **Stripe**, **SendGrid** (u otro), **Twilio** (si usarás SMS), un **bucket S3/R2 privado**, **Sentry** (opcional), **Mapbox** (opcional), **OpenAI** (opcional).
- [ ] **Revisión profesional** de `public/terms.html`, `public/contractor-terms.html` y `public/privacy.html`, del texto de consentimiento de SMS y de los correos promocionales (CAN-SPAM / TCPA), y de cómo clasificas a los técnicos (contratistas vs empleados) y sus pagos. Nada de esto es consejo legal.

## 1. En tu máquina (30 minutos)
```bash
npm install
npm test            # esperado: todas pasan. Si algo falla, guarda la salida completa.
npm run ui-smoke    # esperado: "UI SMOKE: sin errores"
npm audit           # revisa vulnerabilidades en dependencias
```
- [ ] `npm test` pasa **completo** (la prueba de fotos necesita `sharp`, que `npm install` trae).
- [ ] `npm run ui-smoke` termina sin errores.
- [ ] `npm audit` sin vulnerabilidades altas/críticas (o las has evaluado).

## 2. GitHub + integración continua
- [ ] Sube el repositorio. El flujo `.github/workflows/test.yml` corre la suite en **SQLite y en PostgreSQL** y la prueba de interfaz.
- [ ] **El job de PostgreSQL pasa.** Es la verificación que más falta: aquí es donde aparecerán los errores propios de PostgreSQL.

## 3. Entorno de pruebas (staging) — mismas variables que producción, con claves de prueba
Variables **obligatorias** (el servidor se niega a arrancar sin las marcadas ★):

| Variable | Qué es |
|---|---|
| ★ `NODE_ENV=production` | activa las comprobaciones de seguridad |
| ★ `JWT_SECRET` | cadena larga y aleatoria (Render puede generarla) |
| ★ `DATABASE_URL`, `DB_SSL=true` | PostgreSQL gestionado **con respaldos**; las migraciones corren solas al arrancar |
| ★ `STRIPE_SECRET_KEY` (+ `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`) | claves **de prueba** (`sk_test_…`) en staging. Sin Stripe el servidor no arranca salvo `ALLOW_MANUAL_PAYMENTS=true` |
| ★ `TOTP_ENC_KEY` | **fíjala ANTES de que alguien active el 2FA y no la cambies nunca** (cifra los secretos; si cambia, hay que resetear el 2FA de todos) |
| `PUBLIC_URL` | `https://tu-dominio` (enlaces de correos, bajas, webhooks) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | el primer owner (antes del primer arranque) |
| `EMAIL_PROVIDER=sendgrid`, `SENDGRID_API_KEY`, `HANDYMAN_FROM_EMAIL`, `COMPANY_POSTAL_ADDRESS` | correo desde **tu dominio**; la dirección postal es obligatoria en campañas |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | fotos fuera del disco efímero (bucket **privado**) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `BUSINESS_TZ` | SMS (opcional) |
| `SENDGRID_WEBHOOK_KEY` | secreto de la URL del webhook de rebotes |
| `SENTRY_DSN` (+ `npm i @sentry/node`) | errores (opcional) |
| `OPENAI_API_KEY`, `AI_ENABLED` | asistente de respuestas (opcional; `AI_ENABLED=false` no envía nada) |
| `GEOCODE_API_KEY` | distancia en el emparejamiento (opcional) |

- [ ] Despliega y confirma que `/api/health` responde `ok` (ejecuta `SELECT 1` en la base).
- [ ] **Stripe (modo prueba):** crea el webhook a `https://tu-dominio/api/payments/webhook` con los eventos `payment_intent.succeeded` y `payment_intent.payment_failed`; copia el secreto a `STRIPE_WEBHOOK_SECRET`.
- [ ] **SendGrid:** autentica el dominio (SPF/DKIM) y configura el *Event Webhook* a `https://tu-dominio/api/email/events?key=<SENDGRID_WEBHOOK_KEY>` (rebotes, quejas, bajas).
- [ ] **Twilio:** webhook entrante a `https://tu-dominio/api/sms/inbound`; registra el remitente (en EE. UU., A2P 10DLC: confirma el requisito vigente). **Prueba un STOP real desde tu teléfono** (la validación de la firma no se pudo confirmar contra Twilio).
- [ ] **Activa el 2FA** de tu cuenta owner (pestaña *Security*) y guarda los códigos de recuperación.
- [ ] **Respaldos:** comprueba que existen y **haz una restauración de prueba**.

## 4. Recorrido manual en un navegador (escritorio **y** móvil)
Es lo único que mira cómo se ve. Usa la tarjeta de prueba de Stripe `4242 4242 4242 4242`.
1. [ ] Invitado: crea una solicitud con fotos y marca la casilla de SMS → ve el estimado.
2. [ ] Crea cuenta (verifica el correo) → la solicitud queda en tu cuenta.
3. [ ] Admin: crea y envía la cotización → el cliente la acepta (con términos) y **paga el depósito** → el trabajo pasa a *deposit paid*.
4. [ ] Admin (despacho): asigna un contratista → el contratista acepta → agenda una visita → llega el SMS de confirmación. **Repite con un técnico propio** (owner: *Contractors → Add a company technician*): se le asigna directo, sin oferta, y al completarse no aparece pago en *Payouts*.
5. [ ] Contratista: «On my way» → llega el SMS; sube fotos; completa hitos → el cliente los aprueba.
6. [ ] Cliente: **firma la hoja de cierre** (con el dedo en el móvil) → **paga el saldo final**.
7. [ ] Admin (finanzas): el pago al contratista aparece en *Payouts* → apruébalo y márcalo pagado.
8. [ ] Cliente: deja una reseña.
9. [ ] **Disputa:** el cliente reporta un problema → pagos retenidos → soporte responde por cada canal → finanzas resuelve con reembolso parcial.
10. [ ] **Roles:** invita a alguien como *support* y comprueba que no ve costos, dinero ni reportes.
11. [ ] **Campaña:** crea una plantilla, encola, mira que el correo lleve el enlace de baja y la dirección; da de baja desde ese enlace.
12. [ ] **Accesibilidad:** recorre el portal con el teclado y con un lector de pantalla (VoiceOver/TalkBack), sobre todo los diálogos de firma y de reporte.
13. [ ] KPIs: abre la pestaña *KPIs* y comprueba que los números coinciden con lo que acabas de hacer.

## 5. Piloto cerrado (producción, pocos clientes)
- [ ] Cambia a claves **live** de Stripe; repite un pago real pequeño y reembólsalo.
- [ ] Empieza con **pocos clientes y 2–3 contratistas verificados** que conozcas. Revisa cada día: *Payouts*, *Disputes*, mensajes marcados y el registro de SMS.
- [ ] Criterios para ampliar: sin errores 5xx en Sentry, cobros conciliados con Stripe, cero disputas sin resolver, entregabilidad del correo comprobada.
- [ ] Plan de reversa: cómo pausar nuevas solicitudes y a quién avisas.

## 6. Lo que este repositorio todavía NO tiene
Cuadrillas (equipos de varios técnicos) y nómina de técnicos propios (hoy solo existe el tipo «técnico propio»), WhatsApp, mover el dinero a contratistas desde la app (Stripe Connect), PDF de la hoja de cierre, cola de trabajos externa (hoy corre en el proceso), antibots, CSP, paginación, español en la interfaz, descuento por referido aplicado al precio. Ver `AUDIT_CHANGES.md` («NO incluido»).
