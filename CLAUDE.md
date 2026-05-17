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

**Tokens server-side en Supabase Vault:** Shopify access_token Y Whaapy api_key, ambos cifrados por organización. Whaapy api_key vuelve a Vault tras el Ajuste post-Discovery 2 #14 (sincronización bidireccional de contactos requiere llamadas salientes server-side a Whaapy — crear/actualizar/asignar contactos). El iframe de la pestaña Whaapy sigue usando sesión nativa del navegador para operación conversacional; la api_key cubre exclusivamente APIs salientes server-side.

Stack documentado en detalle en Sección 3.1 de la doctrina (`CENTR-DOCTRINE-v5.md`).

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
- **Excepción — datos de contacto** (sincronización bidireccional, Ajuste post-Discovery 2 #14): granularidad **por campo individual**, no por registro. Cada campo del contact lleva metadata de su última actualización (timestamp + fuente); update con valor más viejo en un campo específico no lo sobrescribe aunque el resto del payload sea más reciente. Ver R3 en Sección 3.3.10 para detalle completo.
- **Borrados intencionales propagados:** si un campo viene vacío en un update reciente, el vacío **SÍ sobrescribe** el valor existente. El usuario pudo haber borrado el dato deliberadamente; preservar el valor antiguo contradice la intención. Aplica a campos editables (nombre, email, teléfono, dirección, notas); NO aplica a identificadores externos (`shopify_customer_id`, `whaapy_contact_id`).
- **Excepción del match inicial:** cuando un contacto de Shopify hace match con uno de Whaapy por primera vez, los campos de Shopify tienen prioridad en el enriquecimiento inicial (Shopify es fuente principal); valores vacíos en Shopify no borran valores existentes en Whaapy. Después del match inicial, LWW por campo universal con borrados propagados.

**Sincronización bidireccional de contactos (Ajuste post-Discovery 2 #14 — O11):**
- La base maestra de contactos en la plataforma es la **fuente única de verdad**. Shopify y Whaapy son espejos sincronizados.
- Tres disparadores generan llamadas salientes:
  - Webhook inbound de Shopify (`customers/create` o `customers/update`) → si el contacto no existe en Whaapy aún, crear vía API; si existe, propagar update.
  - Webhook inbound de Whaapy (`contact.created`, `contact.updated`, o evento de asignación de asesor) → análogo hacia Shopify.
  - Edición manual del contacto en M6 (vendedor o admin) → propagar a Shopify Y Whaapy.
- **Defensa anti-bucle obligatoria desde el primer commit (R11):** las llamadas salientes se marcan con identificador de origen "plataforma" (mecánica concreta — propiedad custom, header, comparación de timestamps — la decide Claude Code en M3 y M4 según lo que cada API permita). Webhooks entrantes que reflejen un cambio propio se descartan + audit log `sync_loop_prevented`. **Sin esta defensa, el primer edit de cualquier contacto genera loop infinito con cuotas de API consumidas en minutos** — no es optimización, es requerimiento operativo.
- API saliente falla → Inngest reintenta con backoff. Tras N retries fallidos → DLQ + notificación al admin. El maestro queda en estado correcto (escritura local persistió antes de invocar saliente); solo propagación al externo está pendiente.
- Contacto sin teléfono que llega desde Shopify → flag `missing_phone = true` + NO crear en Whaapy (Whaapy requiere teléfono). Indicador visible al vendedor en M6 detalle.

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
Tokens server-side de proveedores externos (**Shopify access_token y Whaapy api_key**) se rotan cada 90 días. Procedimiento documentado en password manager de VADAI. Tokens viven cifrados en Supabase Vault, asociados a la organización. **Whaapy api_key entra de nuevo a este SOP** tras el Ajuste post-Discovery 2 #14 — la sincronización bidireccional de contactos requiere llamadas salientes desde código (crear/actualizar/asignar contactos vía API saliente). El iframe sigue usando sesión nativa del navegador para operación conversacional; la api_key cubre exclusivamente las APIs salientes server-side.

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

**Expectativa operativa para M11:** la ejecución del backfill puede tardar **varias horas** según volumen real de Centr (apertura hace varios años). Bulk Operations de Shopify procesa async — el operador lanza la operación, espera al callback de completado, y procesa el archivo de resultados por chunks vía Inngest.

**Si en el futuro se agregan otras organizaciones con rango de backfill distinto** (ej. Rustr quiere "últimos 6 meses"), ahí sí se parametriza el rango por organización en el script. Para Centr, completo desde apertura.

## Capacitación del admin para distinguir tags

El admin de Centr (Gina o quien sea) debe ser capacitado al usar la pantalla Mapeo de tags (M7) para distinguir:

- **Tags de vendedor** (nombres de personas): clasificar como `vendor` + mapear al vendedor correspondiente.
- **Tags operacionales** (`"Anticipo 50%"`, `"C2"`, `"Factura"`, `"Facturado"`, etc.): clasificar como `informational`. Son información del proceso (estado financiero, ubicación de almacén, producto especial) — NO asignan a nadie. Quedan visibles en la oportunidad como contexto útil para el vendedor, sin disparar lógica de atribución.

Este punto se incluye en la capacitación post-launch de Regina al admin de Centr (operativo, no responsabilidad de Claude Code en M11).

## Sincronización bidireccional de contactos (Ajuste post-Discovery 2 #14)

**Lectura obligatoria antes del primer commit de M3, M4 y M6.** Esta sección documenta el modelo central de sincronización de contactos del MVP. Sin entenderla, M3/M4/M6 no pueden cerrar correctamente.

### Modelo central

La **base maestra de contactos vive en la BD de la plataforma** (entidad Contacto, Sección 3.3.3). Shopify y Whaapy son **espejos sincronizados** — la plataforma orquesta la sincronización para mantener los tres consistentes (Observación O11).

Justificación operativa: hoy Centr edita el mismo dato manualmente en tres sistemas (Shopify para venta, Whaapy para mensajería, Excel para reportes). Es dolor operativo central. Centr Hub resuelve esto al ser fuente única — el vendedor edita en cualquiera de los tres y la sincronización propaga transparentemente a los otros dos.

### Flujo de propagación

Tres disparadores generan llamadas salientes:

1. **Webhook inbound de Shopify** (`customers/create` o `customers/update`) llega a M3 → si el contacto no existe en Whaapy, M3 invoca creación vía worker M4 (cliente outbound Whaapy); si existe, M3 invoca update. Asignación de asesor (cambio de tag de vendedor) también se propaga a Whaapy.
2. **Webhook inbound de Whaapy** (`contact.created`, `contact.updated`, o evento de asignación) llega a M4 → si el contacto no existe en Shopify, M4 invoca creación vía M3 outbound; si existe, M4 invoca update. Asignación nativa de Whaapy se propaga a Shopify como tag mapeada.
3. **Edición manual del contacto en M6** (vendedor o admin) → M6 actualiza maestro inmediatamente, encola propagación a Shopify Y Whaapy vía Inngest. UX no bloquea al usuario (toast "Cambios guardados"; sincronización en background).

### Defensa anti-bucle (R11) — obligatoria desde el primer commit

La sincronización bidireccional crea riesgo de loops infinitos: la plataforma edita → propaga a Shopify y Whaapy → ambos disparan webhooks de vuelta → si la plataforma re-procesa, loop con cuotas de API consumidas en minutos.

**M3 y M4 deben implementar detección de origen antes de procesar updates de sus respectivos sistemas**. Dos opciones técnicas (Claude Code decide cuál según lo que cada API permita):

- **Opción A — Marcador en llamadas salientes:** al invocar API saliente, agregar metafield/propiedad custom o nota interna identificable (`centrhub_origin = "platform"` + timestamp). Webhook resultante con ese marcador → descartar + audit log `sync_loop_prevented`.
- **Opción B — Comparación de timestamps:** llevar registro local de "última escritura outbound por contact_id". Webhook entrante con `updated_at` ≤ última escritura propia → descartar.

**Sin esta defensa, el primer edit de cualquier contacto rompe el sistema en producción.** No es optimización — es requerimiento operativo. Los tests sintéticos de M3 y M4 deben validar explícitamente que el loop NO ocurre antes del commit final.

### Granularidad de last-write-wins refinada (R3)

- **Draft Orders y Orders:** LWW a nivel **registro entero** (fuente única Shopify).
- **Contacts:** LWW **por campo individual**. Cada campo del contact lleva metadata de última actualización (timestamp + fuente). Update con valor más viejo en un campo no lo sobrescribe aunque el resto del payload sea más reciente.
- **Borrados intencionales propagados:** campo vacío en update reciente SÍ sobrescribe (el usuario pudo haber borrado deliberadamente). Aplica a campos editables; NO aplica a identificadores externos.
- **Excepción del match inicial:** primer enlace Shopify↔Whaapy prioriza Shopify; valores vacíos en Shopify NO borran valores existentes en Whaapy. Después del match, LWW por campo universal con borrados propagados.

### Casos edge cubiertos

- **Contacto sin teléfono desde Shopify** → flag `missing_phone = true` en maestro. NO se crea en Whaapy (Whaapy requiere teléfono). Visible al vendedor en M6 detalle. Cuando vendedor agrega teléfono via M6, M6 dispara creación en Whaapy.
- **API saliente falla** (rate limit, red, token inválido) → Inngest reintenta con backoff. Tras retries → DLQ + notificación al admin. Maestro queda en estado correcto; solo propagación pendiente.
- **Backfill de M11** → la sincronización bidireccional se **suprime** durante el backfill vía flag `backfill_in_progress` que activa modo pasivo en M3/M4. Sin este aislamiento, cada customer leído generaría un sync de vuelta innecesario, saturando APIs.

### Cómo se distribuye en el código

- **M3:** webhooks Shopify inbound + cliente outbound a Shopify Admin API + defensa anti-bucle del lado Shopify.
- **M4:** webhooks Whaapy inbound + cliente outbound a Whaapy + defensa anti-bucle del lado Whaapy.
- **M6:** UI de edición de contacto + reasignación admin + invocación del flujo de propagación (no implementa el cliente outbound directamente — usa los clientes M3/M4 ya construidos).

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
