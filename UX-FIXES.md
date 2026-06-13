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

### M1v2 correctivo — Mi Día y Reglas ya tienen identidad visual (indigo→violeta + ámbar); propagar la paleta de marca final

- **Componente o pantalla:** `app/(dashboard)/mi-dia/*` (header de indicadores, cards, campanita, racha en sidebar, empty state) y `app/(dashboard)/admin/reglas/*` (rule rows, toggle, header). Nuevo `components/ui/switch.tsx` (toggle reutilizable).
- **Issue detectado / decisión aplicada:** el correctivo M1v2 sacó Mi Día del molde plano y le dio jerarquía + profundidad + color semántico (rose=atraso real, emerald=logro, indigo=en curso, ámbar=racha/energía), reusando la paleta semántica del Dashboard (M8.2) y un acento de identidad **indigo→violeta** + **ámbar→naranja** (racha). Campanita rediseñada (botón grande con badge que late en rose si hay alertas). Racha convertida en widget hero con pips de 7 días + barra de progreso. Toggle de Reglas reconstruido con el patrón flex + `border-2 border-transparent` (a prueba de deformación) en `components/ui/switch.tsx`. **Nota para F7:** cuando se defina la paleta de marca final de Centr (blanco/negro + amarillo `#FFD400`, ver entrada "Paleta de marca"), estos gradientes indigo/violeta deben re-tokenizarse a los colores de marca — hoy están hardcodeados en clases Tailwind. La identidad ya existe; F7 la alinea a la marca, no la crea de cero.
- **Sub-sesión de F7 sugerida:** C (componentes funcionales) + D (admin/reglas); depende de la definición de tokens de B.
- **Severidad:** baja (es polish ya entregado; F7 solo re-tokeniza a marca).

### "Ver cerradas" se colapsa si entra un polling fallback (Fix de pipeline P1)

- **Componente o pantalla:** `app/(dashboard)/pipeline/` — botón "Ver cerradas (N)" por columna Ganada/Perdida (auto-ocultar cerradas).
- **Issue detectado:** al expandir las cerradas de una etapa, el estado `showClosedByStage` es local al tablero y se resetea en `applyState`. Las acciones que lo resetean son intencionales (toggle de funnel/filtro/umbral) EXCEPTO el **polling fallback** (cada 30s cuando Realtime está caído): si el usuario expandió "Ver cerradas" y entra un poll, la columna se colapsa a la vista filtrada. Con Realtime funcionando (hook M5-DT-01) el poll casi no corre, así que el impacto real es bajo; pero conviene preservar el expandido a través de los polls (o re-fetchear las etapas expandidas con `showClosed: true` dentro de `handlePollingTick`).
- **Sub-sesión de F7 sugerida:** C (componentes funcionales).
- **Severidad:** baja.

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

### Toast de confirmación del pipeline (M5)

- **Componente o pantalla:** `app/(dashboard)/pipeline/pipeline-toast.tsx`.
- **Issue detectado:** el toast de confirmación se ve mal y no combina con la plataforma — señalado como ajuste de estética prioritario durante el CHECKPOINT M5. Tipografía, paddings, bordes redondeados, sombras y colores deben alinearse con el sistema de diseño que F7 defina (paleta blanco/negro + amarillo Centr).
- **Sub-sesión de F7 sugerida:** C (componentes funcionales).
- **Severidad:** media.

### Badge de origen en card: reconsiderar (M5)

- **Componente o pantalla:** `app/(dashboard)/pipeline/kanban-card.tsx` — badge de origen (Shopify/Whaapy).
- **Issue detectado:** durante el CHECKPOINT M5 el badge confundió al operador: parecía indicar "dónde existe el contacto" (Shopify y/o Whaapy) cuando en realidad indica el **origen de la oportunidad** (Draft Order Shopify vs auto-creación C2 desde Whaapy). Evaluar: (a) reformular copy/icono para que el significado sea inequívoco; (b) mover el badge al popup de detalle de M6 y dejar la card sin badge de origen; (c) eliminar el badge (el de lead/cliente ya comunica presencia en Shopify; el de origen puede ser ruido). El popup de M6 sí debe mostrar "en qué sistemas externos existe el contacto" sin ambigüedad (ver `PENDIENTES.md` M6-POPUP-01).
- **Sub-sesión de F7 sugerida:** C (componentes funcionales).
- **Severidad:** media.

### Diseño de las cards del kanban: modernizar (M5)

- **Componente o pantalla:** `app/(dashboard)/pipeline/kanban-card.tsx`.
- **Issue detectado:** las cards se ven poco modernas — diseño funcional pero sin personalidad. Tipografía plana, paddings genéricos, jerarquía visual baja (nombre, monto y asesor compiten por atención). F7 debe rediseñar el layout interno priorizando la información que el vendedor consulta de un vistazo (nombre + monto → primario; etapa + asesor → secundario; tags + badges → terciario o trasladado al popup de M6). Considerar micro-interacciones (hover más rico, indicador de "modificada recientemente").
- **Sub-sesión de F7 sugerida:** C (componentes funcionales).
- **Severidad:** alta — es el componente más visible del producto (el vendedor pasa horas con cards delante).

### Contraste card vs fondo de columna (M5)

- **Componente o pantalla:** `app/(dashboard)/pipeline/kanban-column.tsx` (fondo de columna) + `kanban-card.tsx` (fondo de card).
- **Issue detectado:** contraste insuficiente entre la card y el fondo de la columna, en light mode y en dark mode. Las cards "se diluyen" en la columna y cuesta distinguir los límites entre cards apiladas. F7 debe definir tokens de color con separación clara (más contraste en el fondo de columna, borde más definido, sombra más marcada, o un mix).
- **Sub-sesión de F7 sugerida:** C (componentes funcionales).
- **Severidad:** alta — afecta legibilidad y fatiga visual en jornadas largas.

### Scrollbar: rediseño global (M5)

- **Componente o pantalla:** global — todas las superficies con scroll (columnas del kanban, área principal del dashboard, listas largas en admin, futuras listas de contactos en M6 y dashboard en M10).
- **Issue detectado:** el scrollbar usa el estilo nativo del navegador, que se ve desactualizado y no combina con el producto. F7 debe definir tokens de scrollbar (ancho, color de track, color de thumb, hover, border-radius) consistentes con el sistema y aplicarlos vía CSS. Considerar scrollbar "overlay" (que no consuma ancho) en superficies con espacio limitado como las columnas del kanban.
- **Sub-sesión de F7 sugerida:** B (layout/dashboard) — token global.
- **Severidad:** media.

### Variedad visual / fatiga visual (M5)

- **Componente o pantalla:** global — toda la plataforma.
- **Issue detectado:** la interfaz es muy monótona (todo gris/blanco con un solo acento), lo que cansa la vista en jornadas largas y dificulta crear jerarquía visual entre secciones. Señalado como fatigante durante uso prolongado del CHECKPOINT M5. F7 debe introducir acentos de color y jerarquía sin saturar: explotar el color por etapa que ya tienen los stages en la card, badges con paleta variada (no todos del mismo gris), separación más marcada entre secciones (toolbar vs board). Alinear con la paleta blanco/negro + amarillo Centr definida en F7.
- **Sub-sesión de F7 sugerida:** B (layout/dashboard) — tokens globales + propagación a C/D.
- **Severidad:** alta — afecta retención del usuario en jornadas de 8h+.

### Mobile responsive: sidebar y layout global (M5)

- **Componente o pantalla:** layout principal del dashboard + sidebar + propagación a todas las vistas.
- **Issue detectado:** en mobile el sidebar NO se colapsa — ocupa parte de la pantalla, comprime el pipeline y dificulta la navegación. Se necesita responsive completo: (a) sidebar colapsable a icon-only en tablet y oculto detrás de drawer/hamburger en mobile; (b) navbar adaptado a mobile; (c) todas las vistas del dashboard adaptadas (pipeline, admin, dashboard, mi-día, whaapy, contactos) revisando paddings, fuentes, layout de columnas, modales fullscreen en mobile. El drag-and-drop touch + scroll horizontal de columnas del kanban SÍ funcionan hoy — el problema es el chrome del dashboard que lo rodea, no el kanban en sí.
- **Sub-sesión de F7 sugerida:** B (layout/dashboard) como base + propagación a A, C y D.
- **Severidad:** alta — sin responsive el producto es desktop-only, no viable para vendedores en campo.
### Mi Día (M1v2) — íconos emoji, popover de snooze y "cerrada por X"

- **Componente o pantalla:** `app/(dashboard)/mi-dia/` — campanita (`mi-dia-bell.tsx`), racha/sidebar (`mi-dia-sidebar.tsx`), popover de Posponer (`mi-dia-card.tsx`).
- **Issue detectado:** (a) se usan **emoji** como íconos (🔔 campanita, 🔥/💤 racha, ✓ check de completar) — funcionales pero inconsistentes con un set de íconos profesional; F7 debe reemplazarlos por un icon set propio alineado a la identidad Centr. (b) El popover de "Posponer" se cierra por `onMouseLeave` (no por click-outside ni Escape) — en touch puede quedar abierto; conviene un dismiss robusto. (c) **Autoría de completado no surfaced:** cuando el admin cierra la tarea de un vendedor desde la Vista equipo, el actor real queda en `audit_log` pero la UI del vendedor no muestra "cerrada por X". El dato existe (audit + `created_by_rule_id` para origen); F7/V2 puede surfacearlo en el detalle de la tarea/timeline para que el vendedor sepa quién la cerró.
- **Sub-sesión de F7 sugerida:** C (componentes funcionales).
- **Severidad:** baja-media — funcional y consistente con el patrón actual; es pulido + una mejora de trazabilidad visible.

### Admin → Reglas (M1v2) — composer y consistencia visual

- **Componente o pantalla:** `app/(dashboard)/admin/reglas/` (lista + modal composer `rule-form-modal.tsx`).
- **Issue detectado:** la pantalla quedó funcional siguiendo el patrón admin (etapas/motivos): lista por funnel, toggle activar/desactivar, modal de crear/editar. Pendiente F7: armonizar densidad/espaciados con el sistema final, el toggle on/off custom (hoy Tailwind a mano), y la jerarquía del composer (los campos dinámicos por tipo de disparador aparecen/desaparecen sin transición). Acento indigo a migrar a la paleta Centr (blanco/negro + amarillo) cuando se definan tokens.
- **Sub-sesión de F7 sugerida:** D (admin/configuración).
- **Severidad:** baja — no bloquea operación; pulido de consistencia.

### Pantalla Usuarios (M9.2) — polish visual

- **Componente o pantalla:** `app/(dashboard)/admin/usuarios/` (lista de usuarios + modales invitar/vincular/editar/desactivar).
- **Issue detectado:** la pantalla quedó funcional con un layout de tarjetas-fila simple (badges de rol/estado/login, botones de acción inline) consistente con el resto del admin (etapas/mapeo-tags), responsive y dark-mode OK. Pendiente de F7: armonizar densidad/espaciados de las filas con el sistema de diseño final, revisar el wrap de los botones de acción en breakpoints intermedios, y los color-pickers de los modales (paleta de invitar + input de color del editar) para que sigan el patrón visual definitivo.
- **Sub-sesión de F7 sugerida:** D (admin) — junto con etapas/motivos/mapeo-tags.
- **Severidad:** baja — no bloquea operación; es pulido de consistencia visual.
