# CLAUDE.md — Reglas del proyecto Centr Hub

> Documento operativo. Léeme al inicio de CADA sesión de Claude Code en Antigravity.

## Stack y versiones

Stack base: Next.js 14.2.x + Supabase + **Vercel free** + Tailwind + shadcn/ui + Inngest + Upstash Redis.

**Decisión Vercel free (no PRO):** validada en proyectos previos del operador (FindMed, Kibah). Implica:
- **Repo público en GitHub obligatorio** (limitación del tier free). Sin secrets ni credenciales en código — la regla general se refuerza por la visibilidad pública.
- **Crons del proyecto viven en Inngest, no en Vercel.** El tier free de Vercel limita crons y la decisión arquitectónica es independiente: todos los crons del proyecto se ejecutan desde Inngest (cada hora — ver más abajo).
- **Funciones largas (>10s) viven en Inngest también.** Tier free de Vercel limita funciones serverless en duración. El endpoint inicia el job, Inngest lo procesa, el cliente espera con polling o long-running. Aplica principalmente a exports de PDF visual pesados.
- Si en el futuro se justifica migrar a Vercel PRO, se hace entonces — el patrón "crons + jobs pesados en Inngest" se mantiene como decisión arquitectónica.

Las versiones exactas viven en `package.json`. No actualizar versiones de dependencias sin aprobación explícita del operador. Lección Kibah: una actualización aparentemente menor de `@supabase/ssr` rompió flujos de auth durante 3 horas de debugging.

**Credenciales server-side en Supabase Vault:** **Shopify (Client ID + Client Secret + access_token derivado vía client_credentials grant, cacheado)** Y **Whaapy api_key**, todos cifrados por organización. Whaapy api_key entró a Vault con el Ajuste post-Discovery 2 #14 (sincronización de contactos con asimetría en creación y bidireccional en updates requiere llamadas salientes server-side a Whaapy — crear/actualizar/asignar contactos). El iframe de la pestaña Whaapy sigue usando sesión nativa del navegador para operación conversacional; la api_key cubre exclusivamente APIs salientes server-side.

**Modelo de contactos y pipeline post v5.1 de doctrina (mayo 2026):** la doctrina v5.1 introduce cuatro cambios estructurales que sustituyen al modelo v5.0. Sin entenderlos, M3/M4/M5/M6 no pueden cerrar correctamente. Resumen:

- **Clasificación lead vs cliente derivada** — un contacto es **lead** si vive solo en Whaapy (sin `shopify_customer_id`), **cliente** si tiene identidad Shopify enlazada. Propiedad derivada en runtime, no campo manual. Materialización (columna calculada, vista, derivación in-app) queda delegada a Claude Code en M1.
- **Sincronización asimétrica en creación, simétrica en updates** — Shopify → Whaapy creación automática; Whaapy → Shopify creación manual on-demand vía botón "Crear contacto en Shopify" en M6 (modal con campos editables + match defensivo por teléfono normalizado para no duplicar customer Shopify existente). Updates de campos en contactos con ambas identidades enlazadas se propagan automáticamente bidireccional (LWW por campo — R3).
- **Pipeline Funnel Venta de 9 etapas** (reemplaza las 7 del v5.0): Lead nuevo → Contactado asesor → Contacto calificado → Reunión agendada → Diseño de espacios → Cotización → Seguimiento para cierre → Ganada → Perdida. Funnel Post-venta queda intacto.
- **Auto-creación C2 — Modelo C2 (R12)** — POST-backfill, dos disparadores crean automáticamente oportunidad en etapa "Lead nuevo" del Funnel Venta: (a) contacto nuevo entra a Whaapy; (b) contacto existente vuelve a interactuar en Whaapy después de N días sin actividad (default N=30, configurable por admin desde Reglas). Asesor heredado del `assigned_advisor_id` del contacto. Durante el backfill de M11 esta auto-creación se suprime vía flag `backfill_in_progress`. Botón manual "Crear oportunidad nueva" en detalle de contacto sigue existiendo para casos especiales.

Detalle completo en doctrina v5.1: Sección 2.1 (alcance), Sección 3.3.3 (Contacto), Sección 3.3.4 (Oportunidad), Sección 3.3.9 (seeds — 9 etapas), Sección 3.3.10 (R11 + R12), Sección 3.3.11 (O11 + O12), Sección 3.6 (integraciones), Sección 4.2 (flujo operativo).

Stack documentado en detalle en Sección 3.1 de la doctrina (`CENTR-DOCTRINE-v5.md`).

## Setup post-M2: flujo nuevo de Shopify (Dev Dashboard) y scopes de Whaapy

Documentado durante el setup de credenciales reales tras cerrar M2 (mayo 2026). El flujo nuevo de Shopify quedó integrado a la doctrina v5.1 (Secciones 3.1 y 3.6). Esta sección complementa la doctrina con el detalle operativo concreto que aplica al setup local (variables de entorno, scopes activados de Whaapy) y permanece como referencia rápida para el operador.

### Shopify: Custom Apps clásicas no existen tras 1-ene-2026

La doctrina v5.1 (Sección 3.6) documenta el modelo nuevo. Esta subsección reitera el contexto operativo. **El flujo previo donde el merchant creaba una Custom App en `admin.shopify.com` y obtenía un Admin API access token directamente fue retirado por Shopify el 1 de enero de 2026.** Tras esa fecha, toda integración pasa por el **Shopify Dev Dashboard** (`partners.shopify.com` → app creada por VADAI, instalada en cada tienda).

Implicaciones operativas (resumen — doctrina 3.6 documenta el modelo completo):

- **Credenciales entregadas por Shopify cambian.** Antes: un único `access_token` del Custom App. Ahora: par **Client ID + Client Secret** de la app del Dev Dashboard. El `access_token` por tienda se obtiene en runtime con un intercambio **client_credentials grant** contra Shopify.
- **Webhook signing secret = Client Secret.** En el flujo nuevo, Shopify firma los webhooks con el mismo Client Secret. No hay un valor separado para webhooks — se reusa el mismo string.
- **Lo que vive en Vault por organización** ahora son tres valores: `client_id`, `client_secret`, y el `access_token` derivado (cacheado con refresh cuando expire). El SOP de rotación 90 días aplica al Client Secret; el access_token rota por contrato del grant.
- **Para M3:** el cliente outbound de Shopify Admin API debe obtener access_token vía client_credentials grant antes de la primera llamada (o tomarlo del cache en Vault si está vigente). HMAC de webhooks: verificar contra Client Secret.

### Variables nuevas en `.env.local`

La doctrina v5 sólo asumía `SHOPIFY_WEBHOOK_SECRET`. El flujo nuevo requiere tres variables (todas server-side, ninguna `NEXT_PUBLIC_`):

- `SHOPIFY_API_KEY` — Client ID de la app en Dev Dashboard.
- `SHOPIFY_API_SECRET` — Client Secret de la app.
- `SHOPIFY_WEBHOOK_SECRET` — **mismo valor que `SHOPIFY_API_SECRET`** en este flujo. Se mantiene como variable separada por claridad de uso (HMAC verification vs cliente API) y futuro-proofing por si Shopify vuelve a separarlos.

Las tres están en `.env.local` (local) y deben estar en Vercel env (producción). Repo público — nunca commitear `.env.local`.

### Scopes protegidos de Shopify — Custom Apps tienen acceso automático

La app de Centr Hub en el Shopify Dev Dashboard es una **Custom App** (instalada por organización vía flujo OAuth, no publicada en el Shopify App Store). Para esta categoría, los scopes protegidos están **operativos automáticamente al instalar la app** — el consentimiento del merchant se otorga al aprobar los scopes durante la instalación. No hay trámite externo:

- **`read_customers`, `write_customers`** — pertenecen a Protected Customer Data Levels 1 y 2. Custom Apps tienen acceso automático a ambos niveles. **No hay Protected Customer Data Form que llenar.**
- **`read_all_orders`** — mismo modelo. En Custom Apps este scope se aprueba en la instalación. **No requiere request manual en Partner Dashboard.**

**Diferencia con apps públicas del App Store:** los formularios de Protected Customer Data y el request manual de `read_all_orders` aplican **únicamente a apps publicadas en el Shopify App Store** (distribución masiva). Centr Hub no entra en esa categoría — es una integración 1-a-1 por organización en el modelo SaaS multi-tenant. Ver entrada en `ERRORES.md` ("Protected Customer Data malinterpretado") para el malentendido inicial y la regla general.

**Implicación operativa para M3 y M11:**

- Una vez que Centr instala la app en su tienda y aprueba los scopes solicitados, todos están vigentes.
- Si la query de customers o orders devuelve vacío en producción, **es bug** — investigar token mal obtenido, scope omitido en la lista solicitada, o rechazo silencioso en la instalación. NO asumir restricción regulatoria.
- M11 puede ejecutar el backfill completo desde apertura de la tienda Shopify sin bloqueo externo.

### Whaapy: scopes elegidos al generar la API key

Whaapy expone una matriz de scopes al crear la api_key. La doctrina v5 (Sección 3.6) describe el uso conceptual (crear/actualizar/asignar contactos, leer conversaciones para el iframe contextual) pero no fija scopes específicos. **Scopes activados en mayo 2026 para la api_key server-side**:

- `contacts:*` — crear, leer, actualizar contactos. Núcleo del Ajuste post-Discovery 2 #14.
- `conversations:read`, `conversations:write` — lectura para audit/contexto; write para acciones server-side cuando se requiera.
- `team:*` — leer/gestionar la lista de agentes humanos (necesario para mapeo `whaapy_agent_id` ↔ vendedor de la plataforma).
- `funnels:*` — leer/operar funnels (referencia operativa de Whaapy, mapeable a etapas si V2 lo requiere).
- `agent:write` — **latente, no se usa en MVP**. En Whaapy `agent` se refiere al **AI agent** automático, no a asesores humanos. Se marcó por si V2 introduce flujos automatizados; M3/M4/M6 no lo invocan.

**Scopes NO marcados** (decisión consciente para minimizar superficie):

- `messages` — la plataforma no envía mensajes server-side. El envío vive en el iframe (sesión nativa del navegador del vendedor). Si V2 introduce mensajería programática (campañas, follow-ups automáticos), se activa entonces.
- `templates`, `broadcasts` — mismo razonamiento que `messages`.
- `media` — la plataforma no descarga ni sube media. Los archivos viven en Whaapy y se ven vía iframe.

Si un milestone futuro requiere alguno de los scopes no marcados, **regenerar la api_key con scopes ampliados y rotar en Vault** — no asumir que está disponible.

### Operativa Whaapy — rotación de secret HMAC del webhook

Documentado tras el cierre M4 inbound (22-may-2026) — ver entrada `ERRORES.md` "Secret HMAC de Whaapy desactualizado en Vault tras recrear el webhook" para el contexto del bug que lo originó.

**Contexto:** Whaapy NO permite editar el webhook in-place desde el dashboard. Cualquier cambio (URL, eventos suscritos, scopes) obliga a **borrar + crear** el webhook. Cada creación genera un secret HMAC nuevo que se muestra UNA SOLA VEZ en el alert post-creación — no se puede consultar después. Esto significa que la rotación del secret ocurre silenciosamente desde la perspectiva del operador cada vez que se toca la configuración del webhook.

**Sin rotar Vault tras recrear el webhook**, todos los eventos entrantes fallan HMAC verification y se descartan con `exit_reason: "invalid_hmac"`. El síntoma es indistinguible de "endpoint funciona, problema downstream" — HTTP 200 al proveedor, pero ningún contact aterriza en BD. Diagnóstico del bug consumió 8+ iteraciones de debugging hasta que la instrumentación de exit_reason lo expuso.

**SOP de rotación — ejecutar como acción atómica, no como pasos independientes:**

1. **Borrar webhook actual en Whaapy.** Dashboard → Settings → Webhooks → seleccionar webhook → Delete. Whaapy NO permite editar — borrar es el único path para cambiar cualquier configuración.

2. **Crear webhook nuevo y copiar secret del alert.** Dashboard → Settings → Webhooks → Create webhook → configurar URL (`https://<dominio>/api/webhooks/whaapy`) + eventos (`contact.created`, `contact.updated`, `contact.deleted`, `conversation.created`, `conversation.assigned`, `conversation.closed`, `conversation.reopened`) → Save. El alert post-creación muestra el secret en formato `<32 chars hex>`. **Copiar inmediatamente** — el alert solo aparece una vez y no se puede recuperar.

3. **Actualizar Vault con SQL** (Supabase SQL Editor, no migration):
   ```sql
   UPDATE organizations
   SET vault_keys = jsonb_set(
     vault_keys,
     '{whaapy,webhook_secret}',
     to_jsonb('<nuevo_secret_del_alert>'::text)
   )
   WHERE id = '<org_id>';
   ```
   Verificar con:
   ```sql
   SELECT vault_keys->'whaapy'->>'webhook_secret' FROM organizations WHERE id = '<org_id>';
   ```

4. **Disparar webhook test y validar exit_reason.** Desde el dashboard de Whaapy → Test webhook (o re-crear un contacto manualmente). Validar en Supabase:
   ```sql
   SELECT endpoint, exit_reason, created_at
   FROM whaapy_raw_webhooks
   ORDER BY created_at DESC
   LIMIT 5;
   ```
   Esperar `exit_reason = 'enqueue_succeeded'` en el último insert. Si aparece `invalid_hmac`, el secret en Vault NO matchea con el del webhook activo — repetir paso 3.

**Cuándo aplicar este SOP:**
- Cambio de URL del webhook (ej. mover de URL temporal de tunnel a URL de producción).
- Cambio de eventos suscritos (agregar o quitar eventos).
- Cambio del owner del webhook en Whaapy.
- Rotación periódica del secret por SOP de seguridad (90 días — alineado con rotación de api_key).
- Sospecha de filtración del secret.

**Anti-patrón a evitar:** recrear el webhook en Whaapy sin actualizar Vault en la misma ventana de trabajo. El sistema entra en estado "endpoint silencioso" que es muy costoso de diagnosticar a posteriori. La actualización a Vault y la validación con `whaapy_raw_webhooks` son OBLIGATORIAS — no opcionales.

## Skills aplicables y cuándo invocarlas

| Skill | Cuándo invocarla |
|---|---|
| **GSD** | Al inicio de cada milestone para descomponer en tareas. Siempre. |
| **Supabase Developer** | Milestones que tocan BD: M1 (schema base), M3-M4 (sincronizaciones), M5+ (queries de pipeline, motor de reglas, dashboard). |
| **Next.js Supabase Auth** | M2 (auth flow + layout autenticado). M1 (middleware de tenant context que reusa patterns de auth). M11 (flujo final de invitación de usuarios). |
| **Vercel React Best Practices** | Milestones con UI sustantiva: M2 (layout autenticado), M5 (kanban con drag-and-drop), M6 (detalle con iframe), M7 (admin de etapas/motivos/tags), M8 (wizard de reglas), M9 (Mi Día), M10 (dashboard + exportación). |
| **Vercel Composition Patterns** | Mismos milestones que Vercel React Best Practices. Foco en separación Server/Client Components y composición de UI compleja. |
| **UI/UX Pro Max** | SOLO en F7 (sesión dedicada de diseño post-M10). NO usar antes — el polish prematuro encarece milestones sin acelerar entrega. |

**Stripe Upgrade NO aplica** — sin Stripe en MVP.

## Flujo operativo del operador al abrir sesión de milestone

Cada milestone es una sesión nueva de Claude Code en Antigravity — NO se encadenan milestones en la misma sesión. Razón: contexto limpio reduce ruido y errores; cada milestone tiene su scope cerrado.

Procedimiento de apertura de sesión:

1. Abrir sesión NUEVA de Claude Code en Antigravity.
2. Verificar que `CENTR-DOCTRINE-v5.md` está adjunto al proyecto (referencia permanente). El archivo de milestones (`CENTR-MILESTONES-v5.md`) NO se adjunta — solo se copia el prompt específico del milestone que se va a ejecutar.
3. Verificar que `CLAUDE.md`, `ERRORES.md` y `UX-FIXES.md` existen en el repo (desde M0 deben estar).
4. Pegar el prompt del milestone correspondiente (vive en `CENTR-MILESTONES-v5.md`, Sección 11).
5. Ejecutar el milestone. Claude Code ejecuta los pasos siguiendo el prompt + el contexto de la doctrina.
6. Al terminar, validar el checklist de éxito antes de commit final.
7. Cerrar sesión.
8. Abrir nueva sesión para el siguiente milestone.

Si en algún milestone Claude Code parece operar sin contexto de la doctrina, abortar la sesión y volver al paso 2.

## Principios de organización del código

Documentados en Sección 3.2 de la doctrina (`CENTR-DOCTRINE-v5.md`). Resumen:

- Separación capa de datos / negocio / presentación.
- Validación con Zod obligatoria en cada API route, server action y servicio que reciba input externo.
- Constantes centralizadas, no esparcidas.
- Server Components por default; `'use client'` solo cuando se requiera interactividad.
- Archivos <300 líneas.
- Tipos generados desde la BD con tipos custom encima.
- `service_role_key` nunca llega al navegador.

## Patrones operativos críticos

**Multi-tenant defensivo (Sección 3.7):**
- RLS habilitado en toda tabla con `organization_id`.
- Wrapper de contexto de tenant en todo lado donde RLS no aplica nativamente (workers, scripts, edge cases).
- Operar sin contexto explícito = error inmediato.

**Webhooks de Shopify y Whaapy (M3 y M4):**
- HMAC/firma verificada con comparación constant-time ANTES de parsear JSON.
- Dedup atómico en Upstash Redis con `SET NX EX` (TTL 24h).
- Encolado a Inngest para procesamiento async.
- Respuesta 200 al proveedor en <5s.
- Last-write-wins por timestamp del payload contra registro local.
- Idempotencia obligatoria en cada worker.
- NO loguear payloads completos (contienen data sensible).

**Last-write-wins y orden cronológico:**
- Comparar `updated_at` del payload contra el del registro local antes de aplicar.
- Si el del payload es más viejo, descartar y loguear "evento fuera de orden ignorado".
- Granularidad por defecto a nivel registro completo (Draft Orders, Orders).
- **Excepción — datos de contacto** (Ajuste post-Discovery 2 #14, refinado en v5.1): granularidad **por campo individual**, no por registro. Cada campo del contact lleva metadata de su última actualización (timestamp + fuente); update con valor más viejo en un campo específico no lo sobrescribe aunque el resto del payload sea más reciente. Ver R3 en Sección 3.3.10 para detalle completo.
- **Borrados intencionales propagados:** si un campo viene vacío en un update reciente, el vacío **SÍ sobrescribe** el valor existente. El usuario pudo haber borrado el dato deliberadamente; preservar el valor antiguo contradice la intención. Aplica a campos editables (nombre, email, teléfono, dirección, notas); NO aplica a identificadores externos (`shopify_customer_id`, `whaapy_contact_id`).
- **Excepción del match inicial (ajustada en v5.1 al flujo asimétrico):** el "match inicial" ocurre en tres situaciones — (a) Shopify → Whaapy automático: customer nuevo de Shopify dispara creación en Whaapy con los campos del customer; no hay conflicto porque el contacto se crea allá; (b) Whaapy → Shopify manual vía botón "Crear contacto en Shopify": el modal pre-llena con campos del maestro y el vendedor decide los valores finales — NO aplica regla automática "Shopify gana"; (c) match defensivo durante enlace manual: si el modal detecta customer Shopify pre-existente por teléfono normalizado, no duplica, enlaza identidad faltante, y los campos del customer Shopify pre-existente tienen prioridad sobre los del maestro (pero valores vacíos en Shopify NO borran valores existentes en Whaapy/maestro). Después del enlace, LWW por campo universal con borrados propagados.

**Sincronización de contactos con asimetría en creación, simétrica en updates (Ajuste post-Discovery 2 #14 + revisión v5.1 — O11):**
- La base maestra de contactos en la plataforma es la **fuente única de verdad**. Shopify y Whaapy son espejos sincronizados.
- **Direcciones de propagación (modelo asimétrico v5.1):**
  - **Shopify → Whaapy: creación automática.** Customer nuevo en Shopify que no tiene contraparte Whaapy dispara creación en Whaapy vía API saliente (si `missing_phone = false`).
  - **Whaapy → Shopify: creación manual on-demand.** Contacto nacido en Whaapy queda como **lead** en el maestro sin propagación automática a Shopify. El vendedor/admin lo convierte a cliente Shopify explícitamente desde el botón "Crear contacto en Shopify" en M6 (detalle de contacto u oportunidad). Modal con campos editables + match defensivo por teléfono normalizado: si el customer Shopify ya existe, NO se duplica, solo se enlaza la identidad faltante al maestro.
  - **Updates de campos en contactos con ambas identidades enlazadas: bidireccional automático.** Cambios en cualquier sistema (Shopify, Whaapy, M6 edición manual) propagan a los otros dos con LWW por campo (R3).
- **Razón de la asimetría en creación:** la mayoría de contactos que entran a Whaapy sin contraparte Shopify son leads no calificados; crear cada uno automáticamente en Shopify satura el customer base con leads que distorsionan reportes y consumen cuotas. La asimetría refleja la lógica comercial: un lead se vuelve cliente cuando el vendedor decide trabajarlo seriamente.
- **Defensa anti-bucle obligatoria desde el primer commit (R11):** las llamadas salientes se marcan con identificador de origen "plataforma" (mecánica concreta — propiedad custom, header, comparación de timestamps — la decide Claude Code en M3 y M4 según lo que cada API permita). Webhooks entrantes que reflejen un cambio propio se descartan + audit log `sync_loop_prevented`. **Sin esta defensa, el primer edit de cualquier contacto genera loop infinito con cuotas de API consumidas en minutos** — no es optimización, es requerimiento operativo.
- API saliente falla → Inngest reintenta con backoff. Tras N retries fallidos → DLQ + notificación al admin. El maestro queda en estado correcto (escritura local persistió antes de invocar saliente); solo propagación al externo está pendiente.
- Contacto sin teléfono que llega desde Shopify → flag `missing_phone = true` + NO crear en Whaapy (Whaapy requiere teléfono). Indicador visible al vendedor en M6 detalle. Cuando vendedor agrega teléfono via M6, M6 dispara creación en Whaapy.

**Auto-creación de oportunidades en "Lead nuevo" — Modelo C2 (R12, v5.1):**
- POST-backfill, dos disparadores generan oportunidad automática en la etapa marcada como `is_initial = true` del Funnel Venta (semánticamente "Lead nuevo" en el catálogo pre-cargado):
  - Contacto nuevo entra a Whaapy (primera vez en la base maestra de la organización).
  - Contacto existente vuelve a interactuar en Whaapy después de N días sin actividad (default N=30, configurable por el admin desde Reglas).
- Asesor: heredado del `assigned_advisor_id` del contacto (asignación nativa Whaapy). Si el contacto no tiene asesor, la oportunidad queda sin asignar.
- **Pre-condiciones obligatorias:** el Funnel Venta debe tener etapa con `is_initial = true`; el contacto NO debe tener ya oportunidad activa (no terminal) en Funnel Venta; el flag `backfill_in_progress` debe estar en false.
- **Durante el backfill de M11 esta auto-creación está suprimida** vía flag `backfill_in_progress`. Sin esta supresión, cada contacto histórico leído generaría oportunidad sintética que no refleja la realidad comercial.
- Audit log obligatorio `c2_opportunity_auto_created` con disparador (`new_contact_in_whaapy` o `reactivity_after_n_days`), contacto, oportunidad creada, asesor heredado.
- **Botón manual "Crear oportunidad nueva"** en M6 detalle de contacto sigue existiendo para casos donde la auto-creación no aplica (lead capturado fuera de Whaapy, oportunidad adicional sobre contacto activo, corrección de oportunidad eliminada).
- **Materialización delegada a Claude Code:** regla del motor con nuevo tipo de acción `create_opportunity`, servicio dedicado escuchando eventos de M4, worker Inngest con scheduler — Claude Code decide en M4 o M8 según convenga.

**Botón "Crear contacto en Shopify" (M6 — visible en detalle de oportunidad y detalle de contacto):**
- Permitido al asesor asignado del contacto o al admin.
- Modal con campos editables (nombre, email, teléfono, dirección) pre-llenados desde el maestro; el vendedor confirma o ajusta antes de invocar API saliente.
- Al confirmar, la plataforma llama Shopify Admin API `POST /admin/api/.../customers.json` y enlaza el `shopify_customer_id` retornado al maestro.
- **Match defensivo por teléfono normalizado:** si el teléfono ya existe como customer Shopify, NO se duplica — se enlaza la identidad Shopify existente al maestro y se muestra mensaje al vendedor indicando que el customer ya existía.
- Al enlazar `shopify_customer_id`, el contacto transita automáticamente de **lead** a **cliente** (derivación O12).
- Sin teléfono en el maestro: el botón queda deshabilitado con tooltip "Agrega teléfono al contacto antes de crear en Shopify" — Shopify customer requiere teléfono o email mínimo, y Centr opera con teléfono como identidad primaria.

**Clasificación lead vs cliente — derivada, no campo editable (O12):**
- **Lead:** contacto sin `shopify_customer_id` (vive solo en Whaapy o solo en la plataforma). Aún no enlazado a Shopify.
- **Cliente:** contacto con `shopify_customer_id` enlazado.
- Pestaña Contactos (M6) consume esta clasificación para badge visual y filtros (toggle solo-leads/solo-clientes/todos, búsqueda por nombre/teléfono/email, filtro por asesor, filtro por sin-actividad-X-días).
- Transición lead → cliente ocurre automáticamente al enlazar identidad Shopify (sea por sincronización automática Shopify → maestro o por uso del botón "Crear contacto en Shopify").
- **Materialización delegada a Claude Code en M1:** columna calculada (`type` = CASE WHEN shopify_customer_id IS NOT NULL THEN 'cliente' ELSE 'lead' END), vista derivada, o derivación en capa de servicio — cualquiera es válida.

**Pipeline Funnel Venta — 9 etapas pre-cargadas (v5.1, reemplaza las 7 de v5.0):**
1. Lead nuevo (inicial — recibe auto-creación C2 por R12)
2. Contactado asesor
3. Contacto calificado
4. Reunión agendada
5. Diseño de espacios
6. Cotización (llegada automática desde Shopify Draft Order vía webhook `draft_orders/create`)
7. Seguimiento para cierre
8. Ganada (automática al recibir webhook `orders/paid`)
9. Perdida (requiere motivo)

Funnel Post-venta queda intacto (6 etapas). Todas las etapas son editables por el admin desde M7 (nombre, orden, color, flags, probabilidad inicial). Lo único estructural no eliminable: cada Funnel Venta debe tener al menos una etapa inicial, una ganada y una perdida.

**Cancelación de oportunidades — modelo independiente de etapa (migración 0014, M3):**

Una oportunidad cancelada NO es lo mismo que una oportunidad perdida. "Perdida" es una transición real del pipeline (vendedor compitió y perdió contra precio/competencia/ghosting → requiere motivo, impacta win rate). "Cancelada" es un side-flag administrativo (Draft Order borrado por error, duplicado, prueba, o auto-borrado de Shopify tras 1 año → NO impacta win rate, NO requiere motivo).

Modelo en BD: `opportunities.cancelled_at` + `cancellation_source` + `cancellation_note` (columnas agregadas por migración 0014). `cancelled_at IS NULL` = activa. La etapa se PRESERVA al cancelar (auditoría: "esta opp estaba en X etapa cuando se canceló"). NO se inserta entrada en `opportunity_stage_history` al cancelar — no hubo cambio de etapa.

**Disparadores de cancelación cubiertos hoy (M3):**
- Webhook `draft_orders/delete` → worker marca `cancellation_source = 'shopify_draft_deleted'`.

**Disparadores futuros (no implementados todavía):**
- Acción manual del admin desde M6 detalle → `cancellation_source = 'admin_manual'`.
- Limpieza automática del sistema (ej. opp huérfana detectada por job) → `cancellation_source = 'system_other'`.

**Reglas obligatorias para queries de M5/M6/M10:**
- **M5 (kanban del pipeline):** debe usar `listOpportunities(...)` SIN `includeCancelled` ni `onlyCancelled` — el default excluye canceladas. Una opp cancelada NUNCA debe aparecer como card en el kanban activo.
- **M6 (detalle de contacto — lista de oportunidades del contacto):** mismo default. Si el detalle quiere mostrar "ver canceladas históricas" como sub-vista explícita, pasar `onlyCancelled: true`.
- **M10 (dashboard — win rate):** denominador debe ser `Ganadas + Perdidas` SIN incluir canceladas. Si el query usa `listOpportunities` o equivalente, NO pasar `includeCancelled`. Si la consulta es SQL directa, agregar `cancelled_at IS NULL`.
- **M10 (revenue):** revenue viene de `orders` (R5), no de opportunities. La cancelación de opportunity NO afecta revenue — la orden asociada (si existe) sigue contando. Esto es correcto operativamente: si una opp se canceló pero su orden ya estaba paid, el revenue ya entró.
- **Reportes de auditoría / admin debugging:** pueden usar `includeCancelled: true` o `onlyCancelled: true` según necesidad. Documentar explícitamente en cada query por qué se incluye o se filtra.

**Razón operativa:** sin esta separación, métricas de win rate del vendedor quedan contaminadas por cancelaciones administrativas que no son culpa ni mérito del vendedor. El vendedor que tiene muchas Draft Orders auto-borradas por Shopify (porque trabaja oportunidades de ciclo largo > 1 año) recibiría pérdidas falsas; el admin que limpia DOs duplicados generaría pérdidas falsas masivas. Ver entrada en `ERRORES.md` ("Cancelado ≠ Perdido").

**Trigger F1→F2 atómico (M7):**
- Solo desde webhook `orders/paid`, NO desde movimiento manual.
- Operación atómica con rollback completo si falla cualquier paso.
- Pre-condiciones validadas antes de ejecutar; si fallan, continúa procesamiento normal del webhook sin trigger.

## Procedimiento de testing local con webhooks

Para testing local de webhooks (M3 y M4), exponer `localhost:3000` a internet con `ngrok` o `cloudflared`:

1. Levantar el dev server: `npm run dev`.
2. En otra terminal, levantar el túnel: `ngrok http 3000` (o `cloudflared tunnel --url http://localhost:3000`).
3. Tomar la URL pública generada y configurar webhooks de prueba de Shopify/Whaapy apuntando a ella.
4. Probar el flujo end-to-end localmente.
5. Al cerrar la sesión, limpiar los webhooks de prueba apuntando a la URL temporal (que dejará de funcionar).

## Timezone

Toda la lógica de fechas usa **America/Mexico_City** vía `luxon`. NUNCA usar `new Date()` directo en lógica de negocio sin pasar por luxon — produce bugs sutiles cuando el servidor está en UTC y la operación es "hoy" en zona horaria del cliente.

**Crons operativos cada hora:** los crons del proyecto (evaluación de reglas de tiempo, reactivación de snoozes) se ejecutan **cada hora**, no cada 15 minutos. Razón: Centr opera con dolores medidos en días, no minutos. Una hora es resolución suficiente operacionalmente y reduce carga de infraestructura. Implicación visible al usuario: un snooze "hasta mañana 9 AM" puede reactivar la card entre 9:00 y 9:59 — aceptable y comunicado.

**Futureproofing DST:** Centr opera en México que no usa DST desde 2022. Si en V2 la plataforma se expande a países con DST (Argentina, Chile), luxon con la zona horaria correspondiente lo maneja automáticamente sin acción adicional. No bloqueante para MVP.

## Hook de claim `organization_id` en JWT (M5-DT-01)

Documentado tras el cierre M5-DT-01 (mayo 2026). Cierra la deuda registrada en `ERRORES.md` ("Supabase Realtime no entrega eventos al browser sin claim organization_id en el JWT").

### Qué resuelve

Sin este hook, `public.current_organization_id()` (migración 0001) devuelve NULL en sesiones de navegador porque el JWT estándar de Supabase Auth NO trae `organization_id` en el nivel raíz. Resultado: todas las RLS policies tenant-aware (migración 0009) se cierran, y Supabase Realtime descarta silenciosamente cada evento `postgres_changes` hacia el browser. El polling fallback de M5 (`PIPELINE_POLLING_FALLBACK_MS`, 30s) cubría el camino feliz pero no es real-time real — el hook lo es.

### Cómo funciona

- **Función SQL:** `public.custom_access_token_hook(event jsonb) returns jsonb` (migración 0017). Resuelve la org activa por precedencia: (1) `auth.users.raw_app_meta_data->>'active_organization_id'` validado contra `public.memberships` (debe ser una membership activa del usuario); (2) fallback a la membership activa más antigua del usuario (`ORDER BY created_at ASC LIMIT 1`); (3) sin membership activa → claims sin tocar (RLS bloquea, correcto).
- **Claim emitido en RAÍZ del JWT**, no dentro de `app_metadata` ni `user_metadata`. La función SQL lee con `auth.jwt() ->> 'organization_id'` (mig. 0001 línea 59).
- **Sincronización con switchOrganization:** `lib/actions/auth.ts` espeja `active_organization_id` en `auth.users.app_metadata` vía `admin.auth.admin.updateUserById()` y fuerza `auth.refreshSession()` para que el JWT se re-emita en el acto. El cookie SSR `centr_active_org` queda en sync (fast-path para `getSession()` server-side).
- **Permisos:** la función es SECURITY DEFINER + EXECUTE concedido sólo a `supabase_auth_admin` (rol que invoca GoTrue). Revocado de public/anon/authenticated — NO es una RPC pública.

### Paso operativo obligatorio post-deploy del hook (NO es código del repo)

Tras aplicar la migración 0017, el hook debe **habilitarse manualmente en el Dashboard de Supabase** — sin este paso la función existe pero NO se invoca al emitir JWT:

1. Supabase Dashboard → Authentication → Hooks → "Customize Access Token (JWT) Claims".
2. Habilitar el hook (toggle).
3. Seleccionar la función: schema `public`, función `custom_access_token_hook`.
4. Guardar.

A partir de ese momento cada nuevo JWT emitido por Supabase Auth lleva el claim `organization_id` en la raíz.

### Invalidación de sesiones existentes

JWT cacheado en navegadores con sesión activa NO recoge el claim hasta que se renueve el access_token (TTL configurable en Supabase, default ~1h) o el usuario haga logout/login. Para forzar la invalidación inmediata en el entorno actual (sin usuarios productivos — Centr no ha sido entregado todavía):

```sql
-- Invalida todos los refresh_tokens activos. Próxima request del navegador
-- falla con 401, middleware redirige a /login, próximo login emite JWT con claim.
DELETE FROM auth.refresh_tokens;
```

Si en futuras rotaciones del hook (cambio de lógica de resolución) hay usuarios productivos, este SQL es destructivo — usar en su lugar un flow de re-login coordinado o esperar a la rotación natural del TTL.

### Validación end-to-end

Una vez habilitado el hook + invalidadas las sesiones:

1. **Login nuevo:** abrir `/login`, autenticarse. Verificar en Supabase Dashboard → Authentication → Users → ver el usuario → "View access token" (o decodificar el JWT del cookie sb-* en DevTools del navegador): el claim `organization_id` debe aparecer en la raíz.
2. **Function SQL desde el browser context:** desde SQL Editor de Supabase, abrir como rol `authenticated` con el JWT del user → `SELECT public.current_organization_id();` → debe devolver la org del user, no NULL.
3. **Realtime delivery:** dos navegadores con users de la misma org → drag manual de una card del pipeline en navegador A → navegador B refleja el cambio en <2s SIN esperar el polling fallback (30s). Es el test que M5-CHK-01 documenta.
4. **Switch de org (sólo users multi-org):** desde el OrgSelector cambiar de org → recargar el pipeline → confirmar que se ven oportunidades de la nueva org y no de la anterior.
5. **User sin membership activa:** crear un user sintético sin filas en `memberships`, intentar acceder al pipeline → RLS debe devolver vacío (no es bug, es comportamiento correcto).

### Anti-patrón a evitar

- **NO** modificar `current_organization_id()` para leer de `app_metadata.organization_id`. La función espera el claim en la raíz; cualquier cambio rompe la consistencia entre Barrera 1 (JWT) y Barrera 2 (setting de sesión server-side, que ya escribe a la raíz vía `set_config`). Si la lógica del hook necesita evolucionar, se cambia el hook, no la función de resolución.
- **NO** retirar el polling fallback (`PIPELINE_POLLING_FALLBACK_MS`) hasta que M5-DT-03 se ejecute con validación empírica de que Realtime entrega eventos consistentemente. El hook habilita el camino feliz; el polling sigue como red de seguridad mientras tanto.

## Cambios al stack

Cualquier modificación al stack documentado en `package.json` (agregar dependencia, subir versión mayor, cambiar provider externo) requiere aprobación explícita del operador antes de comitearse. Razón: el stack está fijado por experiencias previas (Kibah, FindMed, Hemenesy) y cualquier desviación inesperada introduce riesgo operacional.

Lo que NO requiere aprobación:
- Agregar componentes nuevos de shadcn/ui (es copia local, no es dependencia).
- Crear módulos internos del repo.
- Pequeños patches del stack actual.

## Convenciones del proyecto

- Idioma del código y comentarios: español para mensajes a usuarios; inglés para nombres de variables/funciones (convención técnica).
- Commits siguiendo el patrón `M{N}: descripción concisa`.
- Tests con Vitest (no Jest — Vitest se integra mejor con Vite y el stack actual).
- TypeScript strict en `tsconfig.json`, `noImplicitAny: true`.

## SOPs operativos

**Rotación de secretos:**
Credenciales server-side de proveedores externos (**Shopify Client Secret y Whaapy api_key**) se rotan cada 90 días. Procedimiento documentado en password manager de VADAI. Credenciales viven cifradas en Supabase Vault, asociadas a la organización. **Whaapy api_key entra de nuevo a este SOP** tras el Ajuste post-Discovery 2 #14 — la sincronización de contactos con propagación bidireccional en updates requiere llamadas salientes desde código (crear/actualizar/asignar contactos vía API saliente). El iframe sigue usando sesión nativa del navegador para operación conversacional; la api_key cubre exclusivamente las APIs salientes server-side.

**Para Shopify en el flujo nuevo (post 1-ene-2026):** lo que se rota cada 90 días es el **Client Secret** (regenerable desde Dev Dashboard). El `access_token` per-tienda rota por contrato del client_credentials grant, no manualmente. Ver sección "Setup post-M2" arriba.

**Backups:**
Supabase Free NO incluye backups automáticos diarios. Backups manuales vía `pg_dump` quedan
como responsabilidad operativa del operador antes de cambios estructurales mayores
(migraciones de schema, cleanups de data). Si el proyecto se mueve a Supabase Pro en V2,
los backups diarios automáticos pasan a ser cobertura nativa.

**Monitoreo:**
- Vercel reporta deploys y errors de frontend.
- Inngest reporta workers fallidos y crons.
- Errores críticos del sistema (RLS violations, tokens expirados, webhooks consistently failing) emiten notificaciones tipo `alert` al admin de la org afectada vía el sistema interno de notificaciones.

## Supuestos operativos del flujo de venta

Documentados aquí porque no son hechos confirmados con prueba mecánica, sino inferencias razonables del operador con base en lógica operativa. Si datos reales durante M3+ revelan otro comportamiento, se actualizan estos supuestos y se ajusta el código.

- **El vendedor pone la tag de identificación al crear el Draft Order en Shopify** (Ajuste post-Discovery 2 #10). Es la primera acción del flujo donde el vendedor ya sabe que es su cliente. Sin cambio estructural en M3 — el parser ya lee tags de Customer, Draft Order y Order, así que cualquier momento de aplicación queda cubierto. Si datos reales revelan que se pone al cobrar o al facturar (no al crear el Draft Order), no es bug; solo se documenta el cambio de supuesto.
- **El vendedor cierra el ciclo de venta con `orders/paid`** (no movimiento manual a "Ganada"). El movimiento manual a etapa ganada es operación administrativa de corrección, no flujo normal.
- **Centr usa tags de Shopify para múltiples propósitos** (Discovery 2 respuesta 1.5): tags de vendedor + tags operacionales (`"Anticipo 50%"`, `"C2"`, `"Factura"`, `"Facturado"`). El parser distingue entre tags clasificadas como `vendor` por el admin (atribución) vs `informational` (informativas, default).

## Alcance del backfill inicial

**Centr Hub backfilea TODO el histórico desde apertura de la tienda Shopify** (Discovery 2 respuesta 2.0). NO es rango parametrizable de "últimos N meses". El scope `read_all_orders` solicitado en M0 es esencial — sin él, Shopify limita a últimos 60 días.

**Sobre la aprobación de `read_all_orders`:** en Custom Apps (modelo Centr Hub) este scope se aprueba en la instalación, sin trámite externo. Ver "Setup post-M2" arriba para detalle del modelo y la entrada en `ERRORES.md` sobre el malentendido inicial.

**Expectativa operativa para M11:** la ejecución del backfill puede tardar **varias horas** según volumen real de Centr (apertura hace varios años). Bulk Operations de Shopify procesa async — el operador lanza la operación, espera al callback de completado, y procesa el archivo de resultados por chunks vía Inngest.

**Si en el futuro se agregan otras organizaciones con rango de backfill distinto** (ej. Rustr quiere "últimos 6 meses"), ahí sí se parametriza el rango por organización en el script. Para Centr, completo desde apertura.

## Capacitación del admin para distinguir tags

El admin de Centr (Gina o quien sea) debe ser capacitado al usar la pantalla Mapeo de tags (M7) para distinguir:

- **Tags de vendedor** (nombres de personas): clasificar como `vendor` + mapear al vendedor correspondiente.
- **Tags operacionales** (`"Anticipo 50%"`, `"C2"`, `"Factura"`, `"Facturado"`, etc.): clasificar como `informational`. Son información del proceso (estado financiero, ubicación de almacén, producto especial) — NO asignan a nadie. Quedan visibles en la oportunidad como contexto útil para el vendedor, sin disparar lógica de atribución.

Este punto se incluye en la capacitación post-launch de Regina al admin de Centr (operativo, no responsabilidad de Claude Code en M11).

## Sincronización de contactos — modelo asimétrico (Ajuste post-Discovery 2 #14 + revisión v5.1)

**Lectura obligatoria antes del primer commit de M3, M4 y M6.** Esta sección documenta el modelo central de sincronización de contactos del MVP. Sin entenderla, M3/M4/M6 no pueden cerrar correctamente.

### Modelo central

La **base maestra de contactos vive en la BD de la plataforma** (entidad Contacto, Sección 3.3.3). Shopify y Whaapy son **espejos sincronizados** — la plataforma orquesta la sincronización para mantener los tres consistentes (Observación O11, refinada en v5.1).

Justificación operativa: hoy Centr edita el mismo dato manualmente en tres sistemas (Shopify para venta, Whaapy para mensajería, Excel para reportes). Es dolor operativo central. Centr Hub resuelve esto al ser fuente única — el vendedor edita en cualquiera de los tres y la sincronización propaga transparentemente a los otros dos.

### Flujo de propagación — asimétrico en creación, simétrico en updates (v5.1)

**Creación:**

1. **Shopify → Whaapy: automática.** Customer nuevo en Shopify dispara creación en Whaapy si no existe contraparte (si `missing_phone = false`). Webhook `customers/create` o `customers/update` llega a M3 → si el contacto no existe en Whaapy, M3 invoca creación vía worker M4 (cliente outbound Whaapy).
2. **Whaapy → Shopify: manual on-demand vía botón.** Contacto nuevo en Whaapy queda como **lead** en el maestro. NO se crea automáticamente en Shopify. El vendedor/admin lo convierte a cliente Shopify desde el botón "Crear contacto en Shopify" en M6 (detalle de oportunidad o contacto). Modal con campos editables + match defensivo por teléfono normalizado para no duplicar customer Shopify existente.

**Updates de campos:** propagación bidireccional automática cuando el contacto tiene ambas identidades enlazadas.

1. Webhook inbound de Shopify (`customers/update`) llega a M3 → si el contacto tiene `whaapy_contact_id`, M3 invoca update en Whaapy.
2. Webhook inbound de Whaapy (`contact.updated`, evento de asignación) llega a M4 → si el contacto tiene `shopify_customer_id`, M4 invoca update en Shopify. Si el contacto es lead (sin identidad Shopify), update se aplica solo en maestro — no hay nada que propagar a Shopify hasta que se enlace identidad.
3. Edición manual del contacto en M6 (vendedor o admin) → M6 actualiza maestro inmediatamente, encola propagación a los sistemas externos que tengan identidad enlazada. UX no bloquea al usuario (toast "Cambios guardados"; sincronización en background).

### Defensa anti-bucle (R11) — obligatoria desde el primer commit

La sincronización con propagación entre sistemas crea riesgo de loops infinitos: la plataforma edita → propaga a Shopify y/o Whaapy → uno o ambos disparan webhooks de vuelta → si la plataforma re-procesa, loop con cuotas de API consumidas en minutos.

**M3 y M4 deben implementar detección de origen antes de procesar updates de sus respectivos sistemas**. Dos opciones técnicas (Claude Code decide cuál según lo que cada API permita):

- **Opción A — Marcador en llamadas salientes:** al invocar API saliente, agregar metafield/propiedad custom o nota interna identificable (`centrhub_origin = "platform"` + timestamp). Webhook resultante con ese marcador → descartar + audit log `sync_loop_prevented`.
- **Opción B — Comparación de timestamps:** llevar registro local de "última escritura outbound por contact_id". Webhook entrante con `updated_at` ≤ última escritura propia → descartar.

**Sin esta defensa, el primer edit de cualquier contacto rompe el sistema en producción.** No es optimización — es requerimiento operativo. Los tests sintéticos de M3 y M4 deben validar explícitamente que el loop NO ocurre antes del commit final.

### Orden de operaciones del worker `whaapyContactUpdated` (M4 commit `e377e2f`)

La doctrina v5.1 y la sección R11 conceptual de arriba describen QUÉ tiene que pasar pero no fijan el ORDEN exacto entre el GET de reconciliación y las dos capas de R11. El worker `whaapyContactUpdated` quedó implementado con la siguiente secuencia, que reemplaza al orden propuesto inicialmente en el prompt de M4 (Claude Code lo razonó al revés durante implementación y la decisión se aceptó tras revisión del operador):

1. **GET reconcile** — `GET /contacts/v1/{id}` contra Whaapy para obtener snapshot completo. El payload `contact.updated` de Whaapy NO trae snapshot (solo `updated_fields` + `name` + `previous_name`), así que el GET es obligatorio antes de aplicar LWW. Fallo → audit `whaapy_reconciliation_failed` + throw → Inngest retry → DLQ. Maestro queda en estado pre-webhook hasta éxito.
2. **R11 opción B** — comparación de timestamps con `last_modified_source='platform'` y ventana echo 30s sobre el contact local. Si descarta: actualiza `last_whaapy_activity_at` + audit `sync_loop_prevented` + return.
3. **R11 opción A** — marker `custom_fields.last_platform_write_at` extraído del snapshot del GET. Ventana 5min hacia atrás (más amplia que la opción B porque cubre latencia del GET reconcile). Si descarta: actualiza `last_whaapy_activity_at` + audit `sync_loop_prevented` con `reason: "custom_field_marker_match"` + return.
4. **LWW por campo** — proposals construidos desde el snapshot reconciliado, reconciliación contra `field_metadata` local. `lwwChangedSomething = Object.keys(reconciled.patch).length > 0` captura si hubo cambios efectivos.
5. **Propagación condicional a Shopify** — `propagateUpdateToShopify(...)` se invoca **únicamente** si las tres condiciones se cumplen: (a) `lwwChangedSomething === true`, (b) el contact tiene `shopify_customer_id` enlazado, (c) `missing_phone === false`. Si LWW no aplicó ningún campo (todos los proposals quedaron `older_ignored`), no hay nada que propagar — se evita un PUT redundante a Shopify Admin API.

**Trade-off aceptado:** el GET corre ANTES de R11, por lo tanto cada webhook eco consume una API call a Whaapy. La alternativa (R11 timestamp primero, GET solo si pasa) ahorra la API call en echoes pero **pierde la posibilidad de cross-check con el marker custom_field**, que es más confiable que la comparación de timestamps (ver entrada en `ERRORES.md` "Falso positivo posible en R11 dentro de la ventana de 30s" — la opción B sola produce falsos positivos cuando un usuario edita el contacto en el sistema externo dentro de la ventana echo post-write outbound). El costo de una API call extra por eco se considera menor que el costo de descartar silenciosamente un edit legítimo del usuario.

**Si un milestone futuro propone reordenar para hacer R11 timestamp primero** (ahorrar la API call al GET para echoes detectables por timestamp), tiene que también re-evaluar la pérdida de precisión: sin el marker como segunda capa, la única defensa es la heurística temporal con sus falsos positivos conocidos. La decisión de M4 fue priorizar correctitud sobre eficiencia. Cualquier cambio futuro debe documentar explícitamente la nueva relación costo/beneficio.

`last_whaapy_activity_at` se actualiza en TODOS los caminos del worker (incluidos los discard paths de R11 B y A) excepto cuando el GET falla (throw para retry sin cambios parciales). Esto preserva la semántica "Whaapy emitió el webhook → registró actividad del lado conversacional, aunque el cambio en sí sea eco propio".

### Granularidad de last-write-wins refinada (R3)

- **Draft Orders y Orders:** LWW a nivel **registro entero** (fuente única Shopify).
- **Contacts:** LWW **por campo individual**. Cada campo del contact lleva metadata de última actualización (timestamp + fuente). Update con valor más viejo en un campo no lo sobrescribe aunque el resto del payload sea más reciente.
- **Borrados intencionales propagados:** campo vacío en update reciente SÍ sobrescribe (el usuario pudo haber borrado deliberadamente). Aplica a campos editables; NO aplica a identificadores externos.
- **Excepción del match inicial (v5.1):** ver sección "Last-write-wins y orden cronológico" arriba para las tres situaciones cubiertas en el flujo asimétrico.

### Auto-creación de oportunidades (R12 — Modelo C2, v5.1)

M4 dispara auto-creación de oportunidad en etapa "Lead nuevo" del Funnel Venta cuando:
- Contacto nuevo entra a Whaapy (primera vez en el maestro).
- Contacto existente registra actividad en Whaapy después de N días de silencio (default N=30, configurable desde Reglas).

Suprimido durante backfill (flag `backfill_in_progress`). Audit log `c2_opportunity_auto_created` obligatorio.

### Casos edge cubiertos

- **Contacto sin teléfono desde Shopify** → flag `missing_phone = true` en maestro. NO se crea en Whaapy (Whaapy requiere teléfono). Visible al vendedor en M6 detalle. Cuando vendedor agrega teléfono via M6, M6 dispara creación en Whaapy.
- **API saliente falla** (rate limit, red, token inválido) → Inngest reintenta con backoff. Tras retries → DLQ + notificación al admin. Maestro queda en estado correcto; solo propagación pendiente.
- **Backfill de M11** → la sincronización y la auto-creación C2 se **suprimen** durante el backfill vía flag `backfill_in_progress` que activa modo pasivo en M3/M4. Sin este aislamiento, cada customer leído generaría sync de vuelta innecesario + oportunidades sintéticas que no reflejan la realidad comercial.
- **Botón "Crear contacto en Shopify" con customer Shopify pre-existente** → match defensivo por teléfono normalizado evita duplicar; enlaza identidad faltante al maestro; mensaje al vendedor: "El customer ya existía en Shopify; se vinculó al contacto."

### Cómo se distribuye en el código

- **M3:** webhooks Shopify inbound + cliente outbound a Shopify Admin API + defensa anti-bucle del lado Shopify. Outbound de Shopify cubre updates a customers existentes + creación de customers via botón M6 + add/remove tags de vendedor (todo condicional a que el contacto tenga `shopify_customer_id`, excepto creación que es la que enlaza ese ID).
- **M4:** webhooks Whaapy inbound + cliente outbound a Whaapy + defensa anti-bucle del lado Whaapy + **auto-creación C2 de oportunidades (R12)**.
- **M6:** UI de edición de contacto + reasignación admin + **botón "Crear contacto en Shopify"** + invocación del flujo de propagación (no implementa el cliente outbound directamente — usa los clientes M3/M4 ya construidos).

## Deuda técnica aceptada

Warnings de Supabase Security Advisor documentados aquí como deuda aceptada. No requieren acción en milestones actuales.

**`citext` en el schema `public`:** Supabase recomienda instalar extensiones en un schema dedicado (ej. `extensions`) para aislarlas de `public`. Mover `citext` requeriría una migración destructiva de todos los tipos y columnas que la usan (tag_mappings.normalized_tag, organizations.slug, etc.), arriesgando ruptura de RLS y datos. **Deuda aceptada para MVP** — si en V2 hay un requerimiento de seguridad que lo justifique, se evalúa la migración completa.

**Leaked Password Protection:** Supabase Security Advisor reporta que esta protección está deshabilitada. Es una feature de **Supabase Pro** — compara passwords contra listas de credenciales filtradas (HaveIBeenPwned). No disponible en Free tier. **No hay acción posible en código** — cuando el proyecto suba a Pro, activar en Dashboard > Auth > Security.

**`is_member_of(uuid)` callable by anon/authenticated:** Supabase Security Advisor seguirá reportando que esta función SECURITY DEFINER es invocable por roles `anon` y `authenticated`. Esto es **intencional y necesario**: la función se usa en RLS policies (`organizations`, `memberships`, todas las tablas tenant). Si los roles autenticados no tienen EXECUTE, cualquier query bajo RLS falla con "permission denied for function". Alternativas evaluadas (SECURITY INVOKER, mover a schema privado) son invasivas y aportan poco — la función solo retorna boolean y consulta tablas con RLS propio. **Warning conscientemente ignorado** — registrado aquí para que aparezca en review futuro como decisión arquitectónica, no oversight.

## Para Claude Code: cuando estás trabajando en un milestone

1. Lee este `CLAUDE.md` primero.
2. Lee `ERRORES.md` para conocer los bugs y workarounds documentados de milestones anteriores.
3. El prompt del milestone correspondiente lo recibes del operador (proviene de `CENTR-MILESTONES-v5.md`, Sección 11). La doctrina del proyecto vive en `CENTR-DOCTRINE-v5.md` adjunto al proyecto — cuando el prompt referencie una sección de doctrina (ej. "Sección 3.2", "R3", "O11"), consulta ahí.
4. Sigue el scope cerrado y `do not modify` del prompt estrictamente.
5. Si encuentras un caso no contemplado en el prompt, **PREGUNTA al operador**, no asumas.
6. Cualquier error nuevo que descubras o workaround que aplique, agrégalo a `ERRORES.md` antes de cerrar el milestone.
7. Cualquier ajuste visual pendiente que detectes durante implementación, agrégalo a `UX-FIXES.md` para que F7 lo procese.
8. Al cerrar el milestone, valida el checklist del prompt antes de hacer el commit final.
