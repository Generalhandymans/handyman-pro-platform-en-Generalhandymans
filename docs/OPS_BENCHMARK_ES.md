# HELPMAN — Fase 4: CRM, Admin & Operations Control Center

## Referencias de producto

### ServiceTitan
Referencia principal para dispatch y operación diaria:
- Daily/Weekly Dispatch Board.
- Asignación y seguimiento desde un tablero operacional.
- CRM conectado con oportunidad → quote → job.
- Métricas y pipeline visibles en un mismo sistema.

### Jobber
Referencia para claridad operacional:
- Home dashboard con acciones urgentes.
- Schedule como hub central.
- Vistas day/week/month.
- Trabajo no programado visible.
- Requests → scheduling → tracking → payment.
- Client Hub conectado al flujo operativo.

### Housecall Pro
Referencia para simplificación:
- Pipeline de ventas.
- Scheduling/dispatch.
- Invoicing/payments.
- Reporting para operación y conciliación.

### Houzz Pro
Referencia para CRM conectado:
- Pipeline con fuentes y actividad.
- Lead → estimate/proposal → project sin reentrada.
- Tasks/follow-ups.
- Activity history.
- Schedule/Gantt y dependencias para trabajos mayores.

## Diseño HELPMAN

HELPMAN no necesita copiar un field-service ERP gigantesco.
Necesita un sistema administrado que responda en segundos:

1. ¿Qué necesita atención hoy?
2. ¿Qué leads se están perdiendo?
3. ¿Qué quotes no han respondido?
4. ¿Qué proyectos están bloqueados?
5. ¿Qué jobs todavía no tienen contractor?
6. ¿Quién es el mejor contractor disponible y por qué?
7. ¿Qué contractor tiene compliance vencido?
8. ¿Qué milestone/change order espera respuesta?
9. ¿Qué pagos están pendientes/fallidos?
10. ¿Cuál es el margen y conversión real del negocio?

## HELPMAN Operations Loop

Lead
→ Qualify
→ Estimate
→ Quote
→ Deposit
→ Dispatch
→ Contractor acceptance
→ Schedule
→ Execute
→ Customer approvals
→ Final payment
→ Review
→ Retention / referral

## Principios

- "Attention first": lo urgente aparece primero.
- "One source of truth": no duplicar estados manualmente.
- "Explainable dispatch": el matching debe mostrar score + razones.
- "Human-in-the-loop": el sistema recomienda; operaciones decide asignaciones sensibles.
- "No silent failures": pagos, mensajes, campañas y SLA fallidos aparecen como riesgo.
- "Audit everything": acciones admin relevantes quedan trazadas.
- "Operational truth over vanity KPIs": tiempo sin respuesta, backlog, conversion y margen importan más que métricas decorativas.
