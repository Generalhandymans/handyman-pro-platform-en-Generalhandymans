# CSP / frontend hardening plan

Actualmente server.js usa Helmet con `contentSecurityPolicy: false` porque admin.html,
customer.html y contractor.html contienen scripts inline.

## No habilitar CSP estricta antes de:
1. Mover cada `<script>...</script>` inline a archivos versionados bajo `public/js/`.
2. Eliminar event handlers inline (`onclick=...`) donde existan.
3. Confirmar que Stripe.js y cualquier otro origen externo requerido está en allowlist.
4. Probar customer/admin/contractor/auth/track end-to-end.
5. Activar una policy en Report-Only.
6. Revisar violaciones.
7. Pasar de Report-Only a enforce.

## Policy objetivo aproximada
- default-src 'self'
- script-src 'self' https://js.stripe.com
- frame-src https://js.stripe.com https://hooks.stripe.com
- connect-src 'self' https://api.stripe.com
- img-src 'self' data: blob: https:
- style-src 'self'
- object-src 'none'
- base-uri 'self'
- frame-ancestors 'none'

No usar `unsafe-eval`.
Evitar `unsafe-inline`; si temporalmente se requieren estilos inline, migrarlos después.
