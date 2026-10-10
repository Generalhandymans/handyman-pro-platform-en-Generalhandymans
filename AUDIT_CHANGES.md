# Cambios aplicados tras la auditoría

**Estado de verificación:** todo el código pasa `node --check` y la lógica pura (detector de contacto, enlaces de baja, distancia) fue probada. **No se ejecutó `npm test` ni se probó contra PostgreSQL, Stripe, SendGrid ni Mapbox**: el entorno donde se hicieron estos cambios no tenía `node_modules` ni red. Antes de usar nada de esto: `npm install && npm test`, y repetir las pruebas con `DATABASE_URL` apuntando a un PostgreSQL de prueba.

## Arreglos críticos
| # | Cambio | Archivos |
|---|---|---|
| C1 | Webhook de Stripe: se espera el procesamiento (`await`), si falla responde 500 para que Stripe reintente, es idempotente, verifica el monto, nunca retrocede el estado del trabajo, SQL válido en PostgreSQL | `routes/payments.js`, `services/stripe.js` |
| C2 | La API recorta por rol: el cliente no recibe `contractor_cost_cents` ni datos de contacto del contratista (solo nombre de pila, calificación y verificaciones); el contratista no recibe `customer_price_cents` ni pagos. `GET /api/projects` devolvía `[{}]` (promesas sin esperar). Listado de pagos: el contratista ya no los ve y se corrigió la precedencia SQL del filtro | `routes/projects.js`, `routes/payments.js`, `public/customer.html`, `public/contractor.html` |
| C3 | KPIs: `/api/reports/overview` devolvía todo vacío; contadores con `.get().c` sin `await` (fallaban en PostgreSQL) | `routes/reports.js`, `routes/jobs.js`, `services/crm.js` |
| C4 | Aceptar cotización es atómico (`UPDATE ... WHERE status='sent'`); SQLite ahora tiene transacción real (`BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`) | `routes/quotes.js`, `db.js` |
| C5 | `POST /api/jobs/:id/claim`: vincula una solicitud de invitado a la cuenta con su `claim_token` | `routes/jobs.js` |
| C6 | Ejecutor de migraciones para PostgreSQL + `002_hardening.sql`; arranque: migra, luego escucha; falla ruidosamente si el arranque falla; `render.yaml` de producción | `db/migrate.js`, `db/migrations/002_hardening.sql`, `server.js`, `render.yaml` |
| C7 | `trust proxy`; `JWT_SECRET` obligatorio en producción; IP real con `req.ip`; correo verificado exigido para aceptar cotización y pagar; el reseteo de contraseña revoca sesiones (`token_version`) | `server.js`, `middleware/index.js`, `routes/auth.js`, `routes/quotes.js`, `routes/payments.js` |
| C8 (nuevo) | Los segmentos de campaña (`.all().map`) fallaban en PostgreSQL; la cola ahora reclama cada fila atómicamente y `send` espera el envío | `services/crm.js`, `routes/campaigns.js` |

## Importantes
- **Saldo final y reembolsos:** `POST /api/payments/final-intent` (solo con todos los hitos aprobados) y `POST /api/payments/:id/refund` (admin).
- **Compuertas de estado:** no se ofrece el trabajo a un contratista sin depósito; no se completa sin hitos aprobados (el admin puede forzar con `force:true`, queda en auditoría). Un depósito manual avanza el trabajo.
- **Producción exige Stripe** (`ALLOW_MANUAL_PAYMENTS=true` solo para un piloto manual).
- **Fotos:** las de proyecto usan el mismo almacenamiento que las de solicitud (S3 si está configurado); se autoriza **antes** de que `multer` escriba a disco; los logs ya no guardan tokens de fotos ni query strings.
- **Correo:** lista de bajas (`email_suppressions`), enlace de baja firmado con confirmación (GET no da de baja; POST sí; compatible con "un clic"), cabecera `List-Unsubscribe`, pie con dirección postal (`COMPANY_POSTAL_ADDRESS`, obligatoria para enviar campañas reales).
- **Emparejamiento:** carga de trabajo real; distancia cuando existen coordenadas (geocodificación Mapbox opcional, apagada por defecto).
- **Mensajería:** mensajes con teléfono, correo o "escríbeme por…" se marcan para soporte (no se bloquean); solo el admin ve la marca.
- **Robustez:** `await` en llamadas asíncronas, `unhandledRejection` registrado, `/api/health` ejecuta `SELECT 1`, marca única (`BRAND_NAME`).
- **Tests:** 12 pruebas de regresión nuevas y 1 prueba existente ajustada (completar exige hitos aprobados).

## NO incluido (no son correcciones, son funciones nuevas o dependen de ti)
Dominio de correo propio (SPF/DKIM/DMARC) y webhook de rebotes; Sentry/alertas; SMS/WhatsApp; agenda y despacho; roles del panel; disputas; hoja de cierre firmada; pagos a contratistas; cuadrillas propias; dashboard de KPIs; CI; IA en el CRM; exportación/borrado de datos del cliente; autenticación de las fotos (siguen siendo URLs con token de 128 bits: se redujo su exposición en logs, pero no es acceso autenticado).

## Falta cablear en el frontend
Llamar a `/api/jobs/:id/claim` tras crear cuenta; pantalla de pago del saldo final; mostrar al admin los mensajes marcados; avisar al usuario cuando su correo no está verificado (el API devuelve `code: EMAIL_NOT_VERIFIED`); formulario para fijar coordenadas del contratista.
