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

## Segunda tanda (continuación)
- **Frontend cableado:** el portal del cliente vincula solicitudes de invitado a la cuenta (`HP.claimPendingJobs`), avisa si el correo no está verificado (con botón para reenviarlo), ofrece **pagar el saldo final** cuando todos los hitos están aprobados y oculta el reintento de depósito si ya está pagado; el admin ve la marca de "posibles datos de contacto" en los mensajes.
- **Privacidad:** `GET /api/me/export` (descarga JSON de tus datos, sin margen ni credenciales) y `POST /api/me/delete` (anonimiza la cuenta con confirmación de contraseña; se bloquea con un proyecto en curso; borra las fotos de solicitud; conserva registros financieros anonimizados).
- **Correo:** `POST /api/email/events?key=…` recibe rebotes, quejas y bajas de SendGrid y los pone en la lista de supresión (`SENDGRID_WEBHOOK_KEY`).
- **Ubicación del contratista:** `PATCH /api/contractors/:id/location` (lat/lng o dirección con geocodificación) para que el emparejamiento use distancia.
- **CI:** `.github/workflows/test.yml` corre la suite en SQLite **y en PostgreSQL** (donde fallaban los errores de `await`).
- **Sentry opcional:** `npm i @sentry/node` + `SENTRY_DSN`; sin eso no hace nada.
- **Tests:** 4 pruebas nuevas (total 30). Tampoco ejecutadas.

## Tercera tanda: agenda del admin
- **Pestaña «Agenda»** en el panel: vista semanal por día (con navegación), cada trabajo muestra cliente, dirección, contratista y etapa; **aviso en rojo cuando un contratista está doble-reservado**; y una lista «Needs a date» para ponerle fechas a los proyectos activos sin agenda, directamente desde la tabla.
- **API:** `GET /api/projects/schedule?from=&to=` (solo admin) y `PATCH /api/projects/:id/schedule` ahora devuelve `conflicts` (avisa, nunca bloquea).
- **Lógica pura** en `services/schedule.js`, probada aparte (choques, ventana de fechas, cruce de año). Prueba de API nueva (31 en total, sin ejecutar).
- **Límites:** la agenda no considera horas (solo días), disponibilidad del contratista ni vacaciones; el choque se calcula solo contra proyectos del mismo contratista.

## Cuarta tanda: hoja de cierre firmada
- **Cierra el eslabón «ejecución → cierre → cobro final»:** cuando todos los hitos están aprobados, el cliente abre la **hoja de cierre** en su portal, confirma que el trabajo está terminado y limpio, escribe su nombre y **dibuja su firma** (dedo o ratón). Se guarda quién firmó, cuándo, desde qué IP y la firma (PNG); se avisa a los administradores y queda en la auditoría.
- **El saldo final exige esa firma** (`final-intent` responde 409 sin ella), y en el portal el botón «Pay final balance» aparece solo después de firmar.
- **Quién ve qué:** el cliente ve su hoja sin la IP; el admin ve todo; el contratista solo ve que está firmada (nunca la firma). `completion_signed_at` aparece en el proyecto.
- **Datos:** tabla `completion_sheets` (SQLite en `db.js`, PostgreSQL en `003_completion_sheets.sql`); una sola firma por proyecto garantizada por `UNIQUE`.
- **Límites:** es una firma dibujada con registro de IP y fecha, útil como constancia; **no es una firma electrónica certificada**. No genera PDF todavía y el admin no tiene aún una pantalla para ver la hoja (el API ya la devuelve). Prueba de API nueva (32 en total, sin ejecutar).

## Quinta tanda: pagos a contratistas
- **Se crea automáticamente un «payable»** (lo que se le debe al contratista = `contractor_cost_cents`) cuando un proyecto con contratista se completa. Es idempotente (una sola vez por proyecto, garantizado por `UNIQUE`) y vence en `PAYOUT_TERMS_DAYS` días (7 por defecto).
- **Admin, pestaña «Payouts»:** lista con filtro, totales «Owed / Paid», **Aprobar**, **Marcar pagado** (método: ach, check, zelle, cash, other + referencia), **Cancelar** (con motivo), «Create missing» para proyectos ya completados y **CSV anual** por contratista para preparar impuestos.
- **Protección:** no se paga a un contratista mientras el cliente aún debe dinero; el admin puede forzarlo a conciencia y queda en la auditoría como `payable.paid_forced`. El pago es atómico (dos admins no pagan dos veces). Al pagar, el contratista recibe un correo.
- **Contratista, pestaña «Payouts»:** ve sus pagos, lo pendiente y lo cobrado (nunca lo que pagó el cliente).
- **Datos:** `contractor_payables` (SQLite en `db.js`; en PostgreSQL ya existía en `001` y `004_contractor_payouts.sql` añade columnas e índice único).
- **Arreglo extra (error preexistente):** volver a enviar la etapa «completed» contaba el trabajo dos veces en el contratista y reenviaba el correo al cliente; ahora esos efectos solo ocurren al **pasar** a completado.
- **Arreglo extra:** `001_initial.sql` trae sus propios `BEGIN;`/`COMMIT;`, que rompían la transacción del ejecutor de migraciones; ahora se quitan antes de ejecutarlo.
- **Límites:** la plataforma **registra** el pago, no mueve el dinero (eso sería Stripe Connect, otra fase). El CSV es un total de pagos, **no un formulario fiscal**: consulta con tu contador qué corresponde. Los reembolsos posteriores al pago no ajustan el payable. Prueba de API nueva (33 en total, sin ejecutar).

## Sexta tanda: dashboard de KPIs
- **Pestaña «KPIs»** en el panel admin (ventana de 30 días, 90 días o 12 meses) con:
  - **Dinero:** cobrado (depósitos + hitos + saldo final − reembolsos, por fecha de pago), reservado, ticket promedio, margen de lo completado y margen proyectado de lo nuevo.
  - **Cuentas por cobrar** con antigüedad (0–30, 31–60, 61+ días) y **cuentas por pagar** a contratistas (con lo vencido).
  - **Embudo** solicitud → cotizada → aceptada → depósito → completada, con la tasa de cada paso.
  - **Velocidad** (medianas): pedir→cotizar, cotizar→aceptar, aceptar→depósito, proyecto→firma de cierre.
  - **Calidad y capacidad:** calificación, hitos rechazados (señal de retrabajo), recompra, proyectos activos sin fecha y doble-reservas.
  - **Fuentes de clientes** con su tasa de aceptación.
- **Qué NO mide, y lo dice en pantalla:** NPS, no-shows y reprogramaciones, costo de adquisición y utilización de contratistas (no hay datos).
- **Cómo se calcula:** `services/kpis.js` es una función pura (recibe filas, devuelve números) probada con datos conocidos: 17 comprobaciones pasaron (cohorte, embudo, medianas, cobrado con reembolsos y pagos fallidos excluidos, antigüedad de cuentas por cobrar, y datos vacíos que dan «—» y no ceros). El endpoint `GET /api/reports/kpis?days=` es solo para admin; prueba de API nueva (34 en total, sin ejecutar).
- **Límites honestos:** las fechas de «depósito pagado» son la fecha del registro del pago (en Stripe, la de creación del intento); no existe fecha exacta de cierre del proyecto, por eso el margen se mide por proyectos **iniciados** en la ventana; las tasas finales del embudo suben a medida que madura la cohorte.

## Séptima tanda: roles del panel
- **Cuatro roles de equipo** (`users.staff_role`; todas las cuentas siguen siendo `role='admin'`, y las que ya existían son **owner** sin tocar nada):
  | Rol | Puede |
  |---|---|
  | **owner** | todo, incluido gestionar el equipo y ver el registro de auditoría |
  | **finance** | pagos, reembolsos, pagos a contratistas, KPIs; ve costos |
  | **dispatch** | asignar, agendar, mover etapas, contratistas; ve costos |
  | **support** | mensajes, cotizaciones, CRM y campañas; **nunca ve el costo del contratista ni el dinero** |
- **Equipo (solo owner):** pestaña «Team» para invitar (llega un correo para fijar contraseña, válido 24 h), cambiar el rol y desactivar. Los cambios de rol aplican de inmediato; desactivar cierra todas las sesiones de esa persona y bloquea su ingreso. **Siempre queda al menos un owner** y nadie puede desactivarse a sí mismo.
- **El panel oculta lo que cada rol no puede usar** y abre en su primera pestaña disponible; el servidor es quien lo hace cumplir (la interfaz es solo comodidad).
- **Archivos:** `services/permissions.js`, `routes/staff.js`, migración `005_staff_roles.sql`. Prueba nueva con la matriz completa de permisos (35 en total, sin ejecutar).
- **Límites:** los mensajes siguen visibles para cualquier miembro del equipo (no hay permisos por conversación), y un miembro de soporte aún puede pedir la creación de un pago final en nombre de un cliente (el cliente es quien paga). No hay autenticación en dos pasos para cuentas con acceso al dinero.

## NO incluido (no son correcciones, son funciones nuevas o dependen de ti)
Dominio de correo propio (SPF/DKIM/DMARC); alertas de Sentry configuradas; SMS/WhatsApp; mapa de visitas y disponibilidad por hora; disputas; PDF de la hoja de cierre; Stripe Connect para mover el dinero; cuadrillas propias; IA en el CRM; autenticación de las fotos (siguen siendo URLs con token de 128 bits: se redujo su exposición en logs, pero no es acceso autenticado).

## Falta cablear en el frontend
Pantalla del admin para fijar coordenadas del contratista (el API ya existe); botones en la interfaz para exportar y borrar la cuenta (los endpoints ya existen); pantalla de reembolsos para el admin. El portal del contratista no se revisó a fondo.
