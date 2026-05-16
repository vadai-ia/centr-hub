# UX-FIXES.md — Ajustes visuales pendientes para F7

> Documento vivo. Cada ajuste visual detectado durante M2-M10 se acumula aquí. F7 (sesión dedicada de diseño post-M10) lo procesa como input principal.

## Estructura de cada entrada

Cada entrada documenta UN ajuste pendiente con la siguiente estructura:

- **Componente o pantalla:** ubicación específica.
- **Issue detectado:** qué se ve mal o falta polish.
- **Sub-sesión de F7 sugerida:** A (públicas/login) | B (layout/dashboard) | C (componentes funcionales) | D (admin/configuración).
- **Severidad:** alta | media | baja.

(Formato y ejemplos ilustrativos en Sección 10.4 de la doctrina, `CENTR-DOCTRINE-v5.md`.)

## Entradas

### Landing diferenciado por rol al login (post-M2)

- **Componente o pantalla:** `app/page.tsx` (redirect raíz tras autenticación).
- **Issue detectado:** Tras login, todos los roles son redirigidos a `/pipeline`. La decisión operativa post-M2 es que cada rol abra en su pantalla de mayor valor inicial: vendedor → `/mi-dia`, admin / superadmin → `/dashboard`. Validar la hipótesis con Diego/Gina antes de implementar definitivo.
- **Sub-sesión de F7 sugerida:** B (layout/dashboard).
- **Severidad:** baja.