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

### Card minimalista del kanban (M5)

- **Componente o pantalla:** `app/(dashboard)/pipeline/kanban-card.tsx`.
- **Issue detectado:** Diseño funcional pero genérico — fondo blanco / gris-800 con borde sutil, badges de origen y tipo en colores planos, sin hover micro-interacciones. Falta: shadow elevation animada en hover, breakpoint visual entre "monto real" y "monto estimado" más expresivo (no solo color), tratamiento distinto para cards "Sin asignar" en vista admin (¿borde amarillo?), tipografía y tracking ajustados a la identidad Centr. Asimismo: las dos badges (origen y tipo) compiten visualmente — F7 debe priorizar UNA por contexto (origen para vendedor que rastrea de dónde viene la opp; tipo para admin que filtra leads vs clientes).
- **Sub-sesión de F7 sugerida:** C (componentes funcionales).
- **Severidad:** alta. Es la primitiva más vista del producto (cada vendedor pasa horas con cards delante).

### Quick-view popup del pipeline (M5)

- **Componente o pantalla:** `app/(dashboard)/pipeline/quick-view.tsx`.
- **Issue detectado:** Layout `<dl>` plano sin jerarquía visual fuerte. Falta: header con identidad clara (avatar/inicial del contacto + nombre prominente), métricas destacadas (monto en hero, asesor en pill), tags Shopify como chips con paleta consistente, línea temporal mínima (creado/modificado en una sola fila). Microcopy del footer ("El detalle completo llegará en una siguiente versión") es honesto pero amerita rewrite suave para no parecer placeholder.
- **Sub-sesión de F7 sugerida:** C (componentes funcionales).
- **Severidad:** media. El quick-view se abre con frecuencia pero el usuario espera ver datos, no diseño — la jerarquía manda.

### Modal de motivo de pérdida (M5)

- **Componente o pantalla:** `app/(dashboard)/pipeline/loss-reason-modal.tsx`.
- **Issue detectado:** Estética estándar shadcn-like, sin polish. Falta: ícono ilustrativo (no emoji — vector minimalista o lottie corto), textarea con counter de caracteres visible, dropdown con tratamiento más premium (similar al issue del org-selector), botón "Marcar como perdida" con color de severidad apropiado (rojo actual está OK pero F7 puede afinar contraste para que no compita con CTAs primarios del resto del producto). Microcopy del título "¿Por qué se perdió?" es directo pero amerita validar tono con Centr — algunos equipos prefieren "Registra el motivo" (más profesional, menos emocional).
- **Sub-sesión de F7 sugerida:** C (componentes funcionales) — modales.
- **Severidad:** media.

### Indicador de conexión Realtime en toolbar (M5)

- **Componente o pantalla:** `app/(dashboard)/pipeline/pipeline-toolbar.tsx` — `RealtimeIndicator`.
- **Issue detectado:** Punto de color + texto al lado, sin animación. El estado "Recarga la página" es importante operativamente pero pasa desapercibido visualmente (solo cambia el color del dot). F7 puede: agregar pulse animation en estado `connecting`, banner sutil top-right cuando `stale` (no solo cambio de texto), tooltip explicativo en hover. Considerar si el indicador debe vivir en navbar global (afectaría todas las pantallas con Realtime: Mi Día en M9, Dashboard en M10) en lugar de toolbar del pipeline. La decisión ergonomica determina si se mueve y cómo en F7.
- **Sub-sesión de F7 sugerida:** B (layout/dashboard) si se promueve a navbar global; C si se queda en el toolbar del pipeline.
- **Severidad:** media.

### Toast del pipeline (M5)

- **Componente o pantalla:** `app/(dashboard)/pipeline/pipeline-toast.tsx`.
- **Issue detectado:** Stack en bottom-right con auto-dismiss en 3.5s. Falta: animación de entrada/salida (slide-in desde derecha + fade-out), íconos por variant (success: check, info: i, error: !), agrupación de toasts duplicados (varios moves consecutivos no deben apilar 5 toasts idénticos), interacción con el indicador de conexión (cuando hay stale, los success toasts deben atenuarse para que el usuario vea claramente que aunque la acción local fue OK, no hay confirmación live del server).
- **Sub-sesión de F7 sugerida:** C (componentes funcionales).
- **Severidad:** media-baja.

### Empty state de columna del kanban (M5)

- **Componente o pantalla:** `app/(dashboard)/pipeline/kanban-column.tsx` — `EmptyState`.
- **Issue detectado:** Texto plano "Sin oportunidades". F7 puede agregar: micro-ilustración (icono apagado, no emoji), microcopy por contexto (Funnel Post-venta vacío entre M5 y M7 debería decir "Las oportunidades llegan automáticamente desde Pago confirmado" para que el vendedor no piense que es un bug), tratamiento de empty state distinto para "etapa vacía pero funnel poblado" vs "funnel completamente vacío" (caso vendedor sin asignaciones).
- **Sub-sesión de F7 sugerida:** C (componentes funcionales).
- **Severidad:** baja.

### Mobile: scroll horizontal del kanban (M5)

- **Componente o pantalla:** `app/(dashboard)/pipeline/pipeline-board.tsx` — contenedor de columnas.
- **Issue detectado:** Las columnas tienen `w-72` fijo y el contenedor padre tiene `overflow-x-auto`. En mobile real, el scroll horizontal es funcional pero la UX es básica: sin indicador visual de "hay más columnas a la derecha", sin snap a columna al soltar, sin scroll indicator persistente. Drag-and-drop con touch funciona pero el touch sensor tiene `delay: 200ms` para distinguir scroll de drag — el long-press sentirá "lento" al usuario móvil. F7 debe definir: si snap-to-column vale la pena en mobile, si el delay del touch sensor se puede acortar manteniendo robustez, y si conviene reemplazar el scroll horizontal por un swiper con paginación visual entre etapas (paradigma diferente — decisión de UX strategy, no solo polish).
- **Sub-sesión de F7 sugerida:** C (componentes funcionales) — mobile.
- **Severidad:** media — depende del peso real del uso mobile en Centr (validar con Diego/Gina).
