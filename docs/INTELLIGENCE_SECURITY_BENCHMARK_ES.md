# HELPMAN — Fase 5: Intelligence, Security & Architecture

## Referencias 2026 analizadas

### Angi AI Helper
- Convierte lenguaje cotidiano del homeowner en una solicitud clara y utilizable por profesionales.
- Usa preguntas dirigidas creadas con conocimiento del rubro.
- Reduce la incertidumbre inicial del cliente.

### ServiceTitan AI / Dispatch Pro / Atlas
- IA integrada al sistema operativo, no un chatbot aislado.
- Usa contexto vivo del negocio.
- Matching considera skills, ubicación, performance y job value.
- Permite recomendaciones con control humano.
- IA para operación, análisis y siguientes acciones.

### Jobber AI
- AI assistant conectado al negocio.
- Draft de quotes, follow-ups y recomendaciones.
- Receptionist/voice para intake y booking.
- La IA actúa dentro de límites configurables.

### Houzz Pro AI
- Genera line items desde descripción o voz.
- Convierte estimates en schedules.
- Analiza notes/logs para sugerir tasks.
- AI takeoffs y mediciones asistidas.
- El usuario revisa y edita el resultado.

## Principio HELPMAN

La IA no reemplaza la fuente de verdad ni toma decisiones legales/comerciales sensibles sola.

HELPMAN Intelligence Layer:

Customer language/photos
→ Structured scope
→ Risk & licensing triage
→ Deterministic estimate
→ Confidence
→ Missing information
→ Human review when needed
→ Quote
→ Schedule suggestions
→ Matching recommendation
→ Operational next actions

## Diferenciadores

1. **AI Scope Builder**
   Convierte descripción + fotos + respuestas en un JSON estructurado y editable.

2. **Photo Intelligence**
   Observaciones, room hints, condiciones visibles y riesgos; nunca diagnostica ocultos como hechos.

3. **Estimate Guardrail**
   La IA propone/estructura; el motor determinístico calcula. Esto evita precios arbitrarios de un LLM.

4. **Risk & Licensing Triage**
   Detecta señales que requieren revisión: eléctrico, gas, estructura, agua, techo, permisos, materiales peligrosos, etc.
   No declara legalidad; marca necesidad de revisión por jurisdicción/trade.

5. **Confidence Engine**
   Evalúa completitud, fotos, datos críticos y riesgos antes de mostrar una estimación como "planning estimate".

6. **Human-in-the-loop**
   Riesgo alto o baja confianza → revisión humana antes de quote final o dispatch.

7. **AI Operations Copilot**
   Sugiere next actions usando datos operacionales; no modifica dinero, compliance o asignaciones sin confirmación.

8. **Explainable AI**
   Cada recomendación guarda input summary, output, model/provider, confidence y razón.

9. **Security by design**
   Producción debe fallar si faltan secretos esenciales.
   Tokens efímeros/sesiones revocables.
   CSP habilitable después de externalizar inline JS.
   Request IDs, audit trail, rate limiting y security events.

10. **Provider abstraction**
   La plataforma no queda amarrada a un único proveedor/modelo.
