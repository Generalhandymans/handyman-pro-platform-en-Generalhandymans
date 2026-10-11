# Cambios aplicados tras la auditoría

**Estado de verificación (actualizado tras la tanda 12):** la suite **sí se ejecutó**, pero en un entorno temporal que armé yo, no con tus dependencias reales: SQLite real (el que trae Node 22), y versiones mínimas de Express, multer, bcryptjs, jsonwebtoken, helmet, express-rate-limit y pino. Resultado: **59 pruebas, 57 pasan** (cobertura de líneas **91 %**). Las 2 que fallan **dependen de ese entorno, no de la aplicación**: una necesita la librería real `sharp` (para crear una foto de prueba) y la otra espera una cabecera estándar que mi limitador simulado no emite. Además se comprobó el arranque en producción (guardas de configuración, salud, páginas, login y que no se crean cuentas demo), el esquema completo contra SQLite real y la lógica pura (TOTP, firma de Twilio propia, KPIs, permisos, zona horaria, redacción para IA).

**Lo que sigue SIN verificarse:** (1) **PostgreSQL** (producción): ninguna consulta ni migración se ejecutó contra él; (2) las **librerías reales** (Express, multer, `sharp`, bcryptjs…) pueden comportarse distinto de mis versiones mínimas; (3) los **servicios externos** (Stripe, SendGrid, Twilio, OpenAI, S3, Mapbox) nunca se llamaron de verdad; (4) las **pantallas** solo se revisaron por sintaxis, nunca se abrieron en un navegador. **Corre `npm install && npm test` en tu máquina** (y en CI contra PostgreSQL): es la confirmación que falta.

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
- **Tests:** 4 pruebas nuevas (total 30).

## Tercera tanda: agenda del admin
- **Pestaña «Agenda»** en el panel: vista semanal por día (con navegación), cada trabajo muestra cliente, dirección, contratista y etapa; **aviso en rojo cuando un contratista está doble-reservado**; y una lista «Needs a date» para ponerle fechas a los proyectos activos sin agenda, directamente desde la tabla.
- **API:** `GET /api/projects/schedule?from=&to=` (solo admin) y `PATCH /api/projects/:id/schedule` ahora devuelve `conflicts` (avisa, nunca bloquea).
- **Lógica pura** en `services/schedule.js`, probada aparte (choques, ventana de fechas, cruce de año). Prueba de API nueva (31 en total).
- **Límites:** la agenda no considera horas (solo días), disponibilidad del contratista ni vacaciones; el choque se calcula solo contra proyectos del mismo contratista.

## Cuarta tanda: hoja de cierre firmada
- **Cierra el eslabón «ejecución → cierre → cobro final»:** cuando todos los hitos están aprobados, el cliente abre la **hoja de cierre** en su portal, confirma que el trabajo está terminado y limpio, escribe su nombre y **dibuja su firma** (dedo o ratón). Se guarda quién firmó, cuándo, desde qué IP y la firma (PNG); se avisa a los administradores y queda en la auditoría.
- **El saldo final exige esa firma** (`final-intent` responde 409 sin ella), y en el portal el botón «Pay final balance» aparece solo después de firmar.
- **Quién ve qué:** el cliente ve su hoja sin la IP; el admin ve todo; el contratista solo ve que está firmada (nunca la firma). `completion_signed_at` aparece en el proyecto.
- **Datos:** tabla `completion_sheets` (SQLite en `db.js`, PostgreSQL en `003_completion_sheets.sql`); una sola firma por proyecto garantizada por `UNIQUE`.
- **Límites:** es una firma dibujada con registro de IP y fecha, útil como constancia; **no es una firma electrónica certificada**. No genera PDF todavía y el admin no tiene aún una pantalla para ver la hoja (el API ya la devuelve). Prueba de API nueva (32 en total).

## Quinta tanda: pagos a contratistas
- **Se crea automáticamente un «payable»** (lo que se le debe al contratista = `contractor_cost_cents`) cuando un proyecto con contratista se completa. Es idempotente (una sola vez por proyecto, garantizado por `UNIQUE`) y vence en `PAYOUT_TERMS_DAYS` días (7 por defecto).
- **Admin, pestaña «Payouts»:** lista con filtro, totales «Owed / Paid», **Aprobar**, **Marcar pagado** (método: ach, check, zelle, cash, other + referencia), **Cancelar** (con motivo), «Create missing» para proyectos ya completados y **CSV anual** por contratista para preparar impuestos.
- **Protección:** no se paga a un contratista mientras el cliente aún debe dinero; el admin puede forzarlo a conciencia y queda en la auditoría como `payable.paid_forced`. El pago es atómico (dos admins no pagan dos veces). Al pagar, el contratista recibe un correo.
- **Contratista, pestaña «Payouts»:** ve sus pagos, lo pendiente y lo cobrado (nunca lo que pagó el cliente).
- **Datos:** `contractor_payables` (SQLite en `db.js`; en PostgreSQL ya existía en `001` y `004_contractor_payouts.sql` añade columnas e índice único).
- **Arreglo extra (error preexistente):** volver a enviar la etapa «completed» contaba el trabajo dos veces en el contratista y reenviaba el correo al cliente; ahora esos efectos solo ocurren al **pasar** a completado.
- **Arreglo extra:** `001_initial.sql` trae sus propios `BEGIN;`/`COMMIT;`, que rompían la transacción del ejecutor de migraciones; ahora se quitan antes de ejecutarlo.
- **Límites:** la plataforma **registra** el pago, no mueve el dinero (eso sería Stripe Connect, otra fase). El CSV es un total de pagos, **no un formulario fiscal**: consulta con tu contador qué corresponde. Los reembolsos posteriores al pago no ajustan el payable. Prueba de API nueva (33 en total).

## Sexta tanda: dashboard de KPIs
- **Pestaña «KPIs»** en el panel admin (ventana de 30 días, 90 días o 12 meses) con:
  - **Dinero:** cobrado (depósitos + hitos + saldo final − reembolsos, por fecha de pago), reservado, ticket promedio, margen de lo completado y margen proyectado de lo nuevo.
  - **Cuentas por cobrar** con antigüedad (0–30, 31–60, 61+ días) y **cuentas por pagar** a contratistas (con lo vencido).
  - **Embudo** solicitud → cotizada → aceptada → depósito → completada, con la tasa de cada paso.
  - **Velocidad** (medianas): pedir→cotizar, cotizar→aceptar, aceptar→depósito, proyecto→firma de cierre.
  - **Calidad y capacidad:** calificación, hitos rechazados (señal de retrabajo), recompra, proyectos activos sin fecha y doble-reservas.
  - **Fuentes de clientes** con su tasa de aceptación.
- **Qué NO mide, y lo dice en pantalla:** NPS, no-shows y reprogramaciones, costo de adquisición y utilización de contratistas (no hay datos).
- **Cómo se calcula:** `services/kpis.js` es una función pura (recibe filas, devuelve números) probada con datos conocidos: 17 comprobaciones pasaron (cohorte, embudo, medianas, cobrado con reembolsos y pagos fallidos excluidos, antigüedad de cuentas por cobrar, y datos vacíos que dan «—» y no ceros). El endpoint `GET /api/reports/kpis?days=` es solo para admin; prueba de API nueva (34 en total).
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
- **Archivos:** `services/permissions.js`, `routes/staff.js`, migración `005_staff_roles.sql`. Prueba nueva con la matriz completa de permisos (35 en total).
- **Límites:** los mensajes siguen visibles para cualquier miembro del equipo (no hay permisos por conversación), y un miembro de soporte aún puede pedir la creación de un pago final en nombre de un cliente (el cliente es quien paga). (El 2FA para esas cuentas se añadió después: ver la octava tanda.)

## Octava tanda: autenticación en dos pasos (2FA)
- **Verificación TOTP** (la de Google Authenticator, Authy, 1Password, Microsoft Authenticator), implementada **sin dependencias nuevas** y **validada contra los 6 vectores de prueba oficiales del RFC 6238**: la contraseña sola ya no abre sesión; el login devuelve un desafío de 5 minutos y la sesión solo nace al enviar el código.
- **Protecciones:** un código solo sirve una vez (anti-repetición, atómico); el desafío se firma con otra clave, así que **nunca funciona como sesión**; el secreto se guarda **cifrado** (AES-256-GCM) y los 8 códigos de recuperación **solo como hash**, de un solo uso; se acepta ±1 paso de reloj; los intentos entran en el límite existente de `/api/auth`.
- **Obligatoria para dinero y equipo:** con `NODE_ENV=production` (o `REQUIRE_2FA=true`) las áreas **finance** y **staff** devuelven 403 `MFA_REQUIRED` hasta que la persona active el 2FA, incluidos los owners; el panel lo avisa y abre la pestaña **Security**. Soporte y despacho no se ven afectados. `REQUIRE_2FA=false` la desactiva.
- **Pantallas:** el login pide el código en un segundo paso (admite código de recuperación); pestaña **Security** para activar (clave manual + código) y desactivar (contraseña + código); en **Team**, el owner ve quién tiene 2FA y puede **restablecer** el de un colega que perdió el teléfono (cierra sus sesiones y queda en auditoría).
- **Datos:** columnas en `users` (SQLite en `db.js`, PostgreSQL en `006_two_step.sql`). Pruebas nuevas (37 en total).
- **Límites:** no hay código QR (se escribe la clave a mano en la app; añadir QR requiere una librería); si cambias `JWT_SECRET` sin haber fijado `TOTP_ENC_KEY`, los secretos de 2FA dejan de poder leerse y habría que restablecerlos: **fija `TOTP_ENC_KEY` antes de activar el 2FA**; solo aplica al equipo, no a clientes ni contratistas.

## Novena tanda: disputas
- **Quién puede reportar:** el cliente dueño del proyecto o el contratista asignado (por ejemplo, «el cliente no aprueba el trabajo terminado»), cuando el trabajo ya empezó. Una disputa abierta por proyecto, garantizada por un índice único parcial.
- **Retención automática:** mientras hay una disputa abierta, **no se puede pagar al contratista** (`DISPUTE_HOLD`) ni crear el **pago final** del cliente. Se libera al resolverse o retirarse.
- **Canales separados (la regla de no contacto directo):** cada mensaje va a un canal —cliente, contratista o interno—. El cliente nunca ve lo del contratista, ni al revés; el contratista no lee la queja del cliente (soporte se la relata) ni ve montos; el cliente tampoco lee la queja del contratista.
- **Resolución (soporte o finanzas):** sin acción, **repetir trabajo** (el proyecto vuelve a «in progress»), **reembolso parcial** o **total**. Los reembolsos y cualquier cambio al pago del contratista (**mantener / reducir / cancelar**) **exigen el rol finance** (y 2FA si la política está activa). El reembolso se hace por Stripe cuando hay cobros por Stripe (del más reciente al más antiguo, hasta lo reembolsable) y el resto se **registra como reembolso manual** para enviarlo fuera de la app. Es **idempotente**: si Stripe falla a medias, reintentar solo envía la diferencia. Nunca se reembolsa más de lo que el cliente pagó neto; el cierre es atómico (dos personas no resuelven a la vez).
- **Pantallas:** cliente («Report a problem» en su proyecto, con seguimiento y botón para retirar), admin (pestaña **Disputes** con conversación por canal, «Start investigating» y formulario de resolución) y contratista (pestaña **Disputes** para reportar y responder a soporte). Los KPIs ahora cuentan disputas abiertas, tasa y reembolsos por disputas.
- **Datos:** `disputes` y `dispute_events` (SQLite en `db.js`, PostgreSQL en `007_disputes.sql`). 3 pruebas nuevas (40 en total).
- **Límites:** no hay plazo máximo para reclamar (no existe fecha exacta de cierre del proyecto); las fotos de evidencia se piden por mensaje (no hay subida dentro de la disputa); «repetir trabajo» no descuenta el contador de trabajos completados del contratista; si el contratista ya cobró, el sistema avisa pero **no** recupera el dinero.

## Décima tanda: SMS y visitas fallidas
- **Tres mensajes:** confirmación al agendar, **recordatorio el día anterior** (automático, cada 10 minutos, solo entre 9:00 y 19:00 de la zona `BUSINESS_TZ`) y **«el técnico va en camino»** (botón del contratista, máximo 1 por 30 minutos por proyecto). Cada texto lleva «Reply STOP to opt out». **Nunca se comparte el teléfono del técnico** (se mantiene el contacto mediado).
- **Consentimiento primero:** solo se envía a un teléfono con consentimiento registrado. Se obtiene con una **casilla sin marcar** en el formulario de solicitud o con el interruptor del portal del cliente; **STOP** lo revoca al instante y **START** lo restaura (webhook `/api/sms/inbound` autenticado con la firma de Twilio). Todo queda en `sms_log` (enviado / fallido / omitido por falta de consentimiento) y el admin lo ve en la Agenda. Al borrar la cuenta se revoca el consentimiento y se borra el historial de textos de ese teléfono.
- **Sin proveedor configurado,** los textos solo se escriben en el log (`console`). Con `TWILIO_*` se envían por la API REST de Twilio (sin librería). El recordatorio es **atómico y reintentable**: dos instancias no lo duplican, y si el envío falla se reintenta en la siguiente corrida; mover la fecha lo rearma.
- **No-shows y reprogramaciones, ahora medibles:** el contratista (o despacho) registra «visita hecha / cliente no estaba / contratista no llegó», y **mover la fecha de un proyecto cuenta solo como reprogramación**. Los KPIs muestran la tasa de no-show y las reprogramaciones (y ya no figuran como «no medido»). Si nadie registra resultados, la tarjeta muestra «—» y cuántos eventos hay, para no aparentar un 0% falso.
- **Archivos:** `services/sms.js`, `routes/sms.js`, migración `008_sms_visits.sql`; tablas `sms_consents`, `sms_log`, `visit_events` y `projects.reminder_sent_at`. 3 pruebas nuevas (43 en total).
- **LO QUE NO ESTÁ VERIFICADO (importante):** (1) **la validación de la firma de Twilio**: implementé el algoritmo documentado (HMAC-SHA1 de URL + parámetros ordenados), pero **la comparación con el ejemplo de la documentación no coincidió** y no pude determinar si el error estaba en mi memoria del valor o en el código; antes de depender de ella, **prueba un STOP real desde tu teléfono** y revisa que se procese; (2) el envío real por Twilio nunca se probó contra el servicio; (3) en EE. UU. suele hacer falta registrar el remitente (A2P 10DLC) para enviar con fiabilidad: confirma el requisito vigente con Twilio, y valida con tu criterio profesional el cumplimiento (TCPA) del texto de consentimiento.
- **Límites:** solo SMS a clientes (no a contratistas); no hay respuestas bidireccionales (cualquier respuesta distinta de STOP/START se ignora); la fecha de visita es por día, no por hora, así que el recordatorio no dice una hora.

## Undécima tanda: asistente de respuestas para soporte (IA con aprobación humana)
- **Qué es:** el botón **«✨ Suggest reply»** en Mensajes y en cada Disputa pone un **borrador** en la caja de texto; la persona lo lee, lo edita y lo envía por la pantalla normal. **No existe ningún endpoint que envíe algo solo**; crear un borrador no envía nada (hay una prueba que lo comprueba). Cada borrador queda registrado con lo que la persona hizo: enviado tal cual, editado o descartado.
- **Con IA o sin IA, y lo dice:** con `OPENAI_API_KEY` el borrador lo escribe el modelo (cualquier API compatible con OpenAI; `AI_MODEL`, `OPENAI_BASE_URL`). **Sin clave, con `AI_ENABLED=false` o si el proveedor falla, es una plantilla simple (no es IA)** y la pantalla lo indica. Nunca falla: cae a la plantilla.
- **Qué sale del servidor (y qué no):** solo roles en vez de nombres, tipo de servicio, etapa, motivo y el texto de los mensajes con **correos, teléfonos, direcciones y enlaces reemplazados**; **sin precios, costos, pagos ni datos de cuenta**. **Límite honesto:** un nombre o un monto que alguien escriba *dentro* de un mensaje no se detecta y viaja tal cual. `AI_ENABLED=false` apaga todo envío.
- **Disputas:** el borrador para el cliente solo ve el canal del cliente, y el del contratista solo el del contratista: **lo que dijo una parte nunca llega al borrador de la otra** (probado con un proveedor simulado que captura la petición).
- **Defensas:** el contenido de los usuarios va marcado como **datos no confiables** (anti-inyección de instrucciones); el texto que devuelve el modelo se **limpia** de correos, teléfonos y enlaces y se **marca** si menciona dinero, hace promesas o se le quitaron datos de contacto; el prompt prohíbe ofrecer reembolsos, precios o fechas. Límite de **30 borradores por persona por hora** (`AI_DRAFTS_PER_HOUR`). Solo el rol **support** (y owner/dispatch) puede pedirlos; el rol finance no.
- **Resumen del caso (sin IA):** botón «Case summary» en la disputa, o `POST /api/ai/summary`: etapa, contratista, fecha, hitos, saldo del cliente, firma de cierre, disputas y visitas fallidas, **construido solo con datos de la base** (nada sale del servidor). Quien no tiene permiso de costos no ve el presupuesto del contratista.
- **Uso (owner):** en Team se ve cuántos borradores hubo, cuántos se enviaron sin editar, descartados y tokens consumidos.
- **Datos:** `ai_drafts` (SQLite en `db.js`, PostgreSQL en `009_ai_drafts.sql`). 3 pruebas nuevas (46 en total).
- **NO verificado:** la llamada real a OpenAI nunca se probó contra el servicio (se probó con un proveedor simulado: forma de la petición, limpieza, fallos y el interruptor). **No he medido la calidad de los borradores reales**; empieza con un par de agentes y revisa cuántos se envían sin editar antes de confiar en ellos. No hay IA para *lead scoring* ni predicción de demanda a propósito: sin clientes reales no hay datos que justifiquen un modelo.

## Duodécima tanda: ejecutar de verdad (y lo que apareció)
- **Primera ejecución real de la suite** (entorno temporal descrito arriba): 31 de 45 pasaron a la primera. Las causas de los 14 fallos, **ninguna era un error de la lógica de negocio**:
  1. **Límite de intentos de login (real):** la suite hace decenas de inicios de sesión desde una sola IP y el limitador (20 por 15 min) respondía 429, lo que tumbó en cascada 9 pruebas. La librería real habría hecho lo mismo. **Arreglo:** el límite ahora se puede configurar (`AUTH_RATE_LIMIT_MAX`, `INTAKE_RATE_LIMIT_MAX`; por defecto sigue siendo 20 y 30), la suite lo sube y el limitador **sigue activo** en las pruebas. No lo subas en producción.
  2. **Tres errores de mis pruebas:** una contraseña equivocada, un proyecto «in progress» donde el recordatorio no aplica, y un código TOTP reutilizado dentro de su ventana de 30 s (la protección anti-repetición funcionó como debía).
  3. **El gancho final de la suite** llamaba a `process.exit(0)` y **cortaba el reporte de la última prueba**: corría y pasaba, pero no se contaba. Ahora espera medio segundo.
  4. Dos pruebas que solo dependen del entorno temporal (`sharp`, cabecera del limitador).
- **Efecto secundario real del anti-repetición del 2FA:** solo cabe **un inicio de sesión con código por ventana de 30 s**, y el código con el que se activa el 2FA queda gastado para esa ventana. Es el comportamiento correcto, pero conviene que lo sepa el equipo.
- **Arranque en producción verificado:** sin `JWT_SECRET` no arranca; sin Stripe (y sin `ALLOW_MANUAL_PAYMENTS=true`) para con un error claro; con el piloto manual explícito arranca, sirve las páginas, deja entrar al admin configurado y **no crea cuentas demo**.
- **Honestidad sobre el alcance:** que 57 de 59 pasen en un entorno con librerías simuladas **no equivale** a que pasen con las reales ni con PostgreSQL. Es una señal fuerte (el esquema, las rutas, los permisos y los flujos funcionan de punta a punta), no una garantía.

## Decimotercera tanda: revisión estática de PostgreSQL (y 3 defectos que ya estaban)
Como PostgreSQL no se pudo ejecutar, lo revisé por inspección: busqué sintaxis exclusiva de SQLite, parámetros que PostgreSQL no sabe tipar, columnas booleanas y agrupaciones, y **comparé columna por columna el esquema de SQLite (ya ejecutado) con las migraciones**: toda tabla y columna que usa el código existe en PostgreSQL. Aparecieron **tres defectos preexistentes** (no eran de mis tandas), todos solo visibles en PostgreSQL y todos corregidos:
1. `services/crm.js`: el generador de tareas de seguimiento usaba `datetime(CURRENT_TIMESTAMP,'+1 day')` escrito a mano, que **no existe en PostgreSQL**. Ahora usa el ayudante que ya elegía la sintaxis según el motor.
2. `services/crm.js`: la búsqueda de duplicados usaba `? IS NULL`; PostgreSQL **no puede inferir el tipo de un parámetro suelto** ahí y rechaza la consulta. Ahora son dos consultas explícitas.
3. `routes/reports.js` (`/ticket`): `substr()` sobre una columna `TIMESTAMPTZ` falla en PostgreSQL. Ahora usa `to_char(..., 'YYYY-MM')` en PostgreSQL.
- **Pruebas nuevas:** el generador de tareas y **todos los reportes** (ocho endpoints, varios sin ejecutar nunca) quedan cubiertos; la suite pasa a 48 pruebas.
- **Límites:** es una revisión por lectura y por búsqueda de patrones, no una ejecución. Puede haber otros problemas de PostgreSQL que solo aparecerán al correr la suite contra él (la integración continua incluida lo hace).

## Decimocuarta tanda: cableado de las pantallas (revisión estática, sin cambios de código)
Como las pantallas nunca se abrieron en un navegador, comprobé por análisis lo que sí se puede comprobar sin uno:
- **Contrato frontend ↔ API:** extraje las **105 llamadas distintas** que hacen las pantallas y las comparé con las **126 rutas registradas** al cargar el servidor: **todas tienen su ruta** (los 2 avisos eran falsos positivos de mi extractor, verificados a mano).
- **Elementos de página:** de **198 identificadores** que busca el código, todos existen en la página (el único aviso, `#ai-usage`, se crea a propósito si falta).
- **Funciones compartidas:** las **30 funciones/propiedades de `HP`** que usan las pantallas existen (el único aviso era un comentario).
- **Qué NO demuestra:** que los botones se vean bien, que el diseño sea usable en el móvil, que no haya errores en tiempo de ejecución al hacer clic, ni la accesibilidad. Eso solo se ve en un navegador.

## Decimoquinta tanda: XSS, correo HTML y un defecto grave en las campañas
- **Revisión de XSS (texto de usuario → pantalla):** de **131 expresiones de plantilla** que insertan texto de usuario en las pantallas, **ninguna llega sin escapar a `innerHTML`**. Los 12 avisos de mi escáner eran seguros: los `toast` escapan su texto, los `textContent` no interpretan HTML, el tipo de foto es una lista cerrada con restricción en la base y la URL de seguimiento codifica el token. Tampoco hay `eval`, `document.write`, URLs `javascript:` ni manejadores en línea con datos de usuario. La plantilla de los correos de aviso escapa título, texto y filas.
- **Defecto corregido (inyección de HTML en campañas):** `renderTemplate` insertaba las variables (p. ej. el **nombre del cliente**) sin escapar en el cuerpo HTML de la campaña. Ahora el cuerpo las escapa; el asunto, que es texto plano, no.
- **Defecto grave corregido, preexistente — las campañas salían con asunto y cuerpo «undefined»:** en la cola de campañas, el parámetro de la transacción se llamaba `t` y **tapaba la variable `t` de la plantilla**, así que `t.subject` y `t.body_html` leían la transacción. **Cualquier campaña real habría enviado «undefined».** Lo encontró una prueba nueva que ejercita el flujo completo por primera vez (plantilla → campaña → cola → envío). **Mi lectura anterior de ese código lo había descartado por error** («shadows t, fine»); el parámetro se llama ahora `tx`.
- **La prueba nueva** verifica además que se omiten las bajas (también las que llegan *después* de encolar), que cada correo lleva el enlace de baja, que encolar dos veces no duplica, que cada fila se envía una vez y que finance no puede lanzar campañas. La suite pasa a 49 pruebas.
- **Límites:** es una revisión por lectura y por búsqueda de patrones; no sustituye una auditoría de seguridad ni una prueba en navegador.

## Decimosexta tanda: cobertura dirigida (83 % → 91 %) y 5 defectos más
Medí qué código **ninguna prueba ejecutaba** (cobertura de Node) y escribí pruebas para lo más delicado. Cada flujo que se ejecutó por primera vez destapó algo:
- **Dinero con Stripe (cobertura de `stripe.js`: 27 % → 98 %).** Con un cliente de Stripe **falso** inyectado (`_setClientForTests`, solo para pruebas) probé: el monto del depósito sale de la cotización y **no** de la petición; un segundo intento cancela el primero; el webhook rechaza firmas falsas, ignora intentos ajenos, **rechaza (500) un monto distinto** para que Stripe reintente, es idempotente y **nunca devuelve un trabajo a un estado anterior**; el saldo final exige hitos aprobados + hoja firmada + sin disputa y es exactamente precio − depósito; los reembolsos son solo de finance, topados a lo reembolsable; y el reembolso de una disputa sale por el cargo más reciente y **un reintento tras un fallo a medias no reembolsa dos veces**. **No apareció ningún error en esa lógica.** (Lo que no prueba: el comportamiento del Stripe real.)
- **Defecto: fotos sin tope total.** El límite de 6 fotos era solo *por petición*: con el token de reclamo se podían subir fotos sin fin repitiendo la petición (hasta 5 MB cada una) y llenar el disco. Ahora hay un tope **por solicitud (6)** y **por proyecto (60)**, comprobado **antes de escribir** y, si un lote lo cruzaría, se rechaza entero y se borran sus archivos.
- **Defecto: la lista de reseñas era pública** y devolvía `customer_id` y `project_id` de todas. Ahora exige sesión y se limita por rol: el cliente ve solo las suyas (de paso corrige que el portal pedía «todas, tope 100» y podía mostrar de nuevo el formulario de una reseña ya hecha), el contratista ve las de sus trabajos **sin saber quién las escribió**, el equipo ve todas.
- **Defecto: canje de códigos de referido.** Era público, **sin límite de intentos** y con códigos de solo 24 bits (16 millones de combinaciones, enumerables). Ahora tiene límite por IP y los códigos nuevos son de 40 bits.
- **Defecto de confianza: la verificación se podía burlar.** Un contratista verificado podía cambiar su número de licencia o su seguro por cualquier texto y **conservar la insignia «verificado» y seguir activo**. Ahora cambiar esos datos anula la verificación correspondiente y un contratista activo vuelve a «pending» hasta que se revise de nuevo (queda en la auditoría).
- **Imprecisión corregida:** marcar como hecha una tarea de seguimiento que no existe respondía 200; ahora 404.
- **Cubierto por primera vez:** subida y entrega de fotos (nombres no adivinables, **sin salto de directorios**, tipo MIME correcto, rechazo de archivos que no son imagen, nada se escribe para quien no está autorizado), reseñas, referidos, verificación de contratistas, lecturas del CRM y sus 7 segmentos, y las ramas de cotizaciones (rechazar, permisos de lectura, términos obligatorios).
- **Lo que sigue sin cubrirse** (necesita librerías o servicios reales): optimización de fotos con `sharp`, almacenamiento S3, geocodificación Mapbox, envío por SendGrid, visión con OpenAI y el estimador con fotos.

## NO incluido (no son correcciones, son funciones nuevas o dependen de ti)
Dominio de correo propio (SPF/DKIM/DMARC); alertas de Sentry configuradas; WhatsApp; mapa de visitas y disponibilidad por hora; PDF de la hoja de cierre; Stripe Connect para mover el dinero; cuadrillas propias; *lead scoring* y predicción con IA (sin datos aún); autenticación de las fotos (siguen siendo URLs con token de 128 bits: se redujo su exposición en logs, pero no es acceso autenticado).

## Falta cablear en el frontend
Pantalla del admin para fijar coordenadas del contratista (el API ya existe); botones en la interfaz para exportar y borrar la cuenta (los endpoints ya existen); pantalla de reembolsos para el admin. El portal del contratista no se revisó a fondo.
