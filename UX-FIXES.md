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

### Paleta de marca: colores principales del UI (post-M2)

- **Componente o pantalla:** pantalla de login (`app/(auth)/login/page.tsx`) y por extensión cualquier componente que use el color primario default (botón "Entrar", links de acción).
- **Issue detectado:** El UI usa morado/indigo como color primario (default de Tailwind). La identidad visual de Centr es blanco/negro con acentos amarillos (`#FFD400`, validado en emails transaccionales de M2). El branding final lo entrega Centr antes de F7 — confirmar paleta exacta con Diego/Gina antes de aplicar.
- **Sub-sesión de F7 sugerida:** A (públicas/login) inicial; el cambio de paleta primaria propaga a B, C y D al definirse en tokens.
- **Severidad:** media.

### Pulir NoAccessScreen (post-M2)

- **Componente o pantalla:** `components/ui/no-access-screen.tsx`, mostrado cuando un usuario autenticado no tiene membership en ninguna organización.
- **Issue detectado:** El componente actual carece de layout, jerarquía visual y estilos consistentes con el resto del producto. Aparece como texto plano con tipografía serif default y botón estilo browser nativo. Es la primera pantalla que verá un usuario en caso de error de configuración — debe transmitir profesionalismo. Necesita: container centrado, jerarquía tipográfica clara, ícono o ilustración, botón estilizado consistente con el sistema, y contexto adicional (qué hacer si esto pasa, a quién contactar).
- **Sub-sesión de F7 sugerida:** A (públicas/login) — comparte la sub-sesión con los flows previos a tener membership.
- **Severidad:** media.

### Paleta dark mode: alinear con identidad Centr (post-M2)

- **Componente o pantalla:** layout autenticado completo en dark mode (sidebar, navbar, área de contenido, contenedores de placeholders). Aplica a todo el sistema cuando el tema oscuro está activo.
- **Issue detectado:** El dark mode actual usa tonos azulados (similar a paleta default de Kibah Inmobiliaria). La identidad visual de Centr es más sobria — base blanco/negro con acentos amarillos `#FFD400`. El dark mode debe reflejar esta misma identidad: grises neutros (al estilo del dark mode de Claude / herramientas premium tipo Linear, Notion oscuro), sin tonos azulados, con jerarquía clara entre fondos, contenedores y bordes. Acento amarillo `#FFD400` reservado para estados activos, CTAs primarios y elementos de marca.
- **Sub-sesión de F7 sugerida:** B (layout/dashboard) — donde se definen tokens del sistema de tema.
- **Severidad:** media.

### Selector de organización: reemplazar select nativo por dropdown custom (post-M2)

- **Componente o pantalla:** `components/ui/org-selector.tsx` en el navbar.
- **Issue detectado:** El selector usa `<select>` HTML nativo del browser, que produce un dropdown chopy, sin transiciones, con estilos inconsistentes con el resto del sistema (font weight, padding, colores de hover, animación de apertura). En multi-tenant SaaS premium el switcher de organización es uno de los elementos de mayor interacción del navbar — debe sentirse smooth, con animación de apertura, hover states bien definidos, y consistente con el resto del UI. Considerar reemplazo por dropdown custom (estilo Radix/shadcn DropdownMenu o equivalente) con transiciones explícitas, ítems con padding generoso, indicador visual de org activa, y posiblemente íconos o avatares por org.
- **Sub-sesión de F7 sugerida:** B (layout/dashboard) — núcleo del navbar autenticado.
- **Severidad:** media-alta. El selector se usa con frecuencia por superadmins; impacta percepción de calidad del producto cada vez que se interactúa.
