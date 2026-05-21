# CENTR-DOCTRINE-v5.md

**Versión:** 5.1
**Fecha:** 21 de mayo, 2026
**Cliente:** Centr (distribuidor oficial CENTR x HYROX México) + futura Rustr
**Stack base:** Next.js 14.2.x + Supabase + Vercel free + Tailwind + shadcn/ui
**Nombre tentativo de la plataforma:** Centr Hub
**Decisión arquitectónica clave:** multi-tenant desde día 1
**Documentos de origen:** `CENTR-RESEARCH-V6.md`, `CENTR-SHOPIFY-API-REFERENCE.md`, `VADAI-Playbook-v6.md`, respuestas Discovery 2 del cliente (mayo 2026), `AUDIT-REPORT.md` (auditoría crítica de v3, mayo 2026), repaso final del operador pre-M0 (mayo 2026), revisión operativa post-M2 con datos reales del flujo GoHighLevel de Centr (mayo 2026)

> **Propósito de este archivo:** contiene las Secciones 1 a 10 del Master Document v5 — la doctrina permanente del proyecto (visión, alcance, arquitectura, modelo de datos, integraciones, UX flows, identidad visual, roadmap, anexos vivos). Se adjunta al proyecto en Antigravity como contexto permanente durante toda la ejecución (M0 a M11).
>
> **Los prompts modulares (M0-M11, Sección 11) viven en archivo separado:** `CENTR-MILESTONES-v5.md`. El operador copia el prompt específico cuando inicia cada milestone — el archivo de milestones NO se adjunta al proyecto.
>
> **Cambios respecto a v5.0 (revisión operativa post-M2, 21 de mayo 2026):** cuatro cambios estructurales al modelo de contactos y pipeline aplicados tras revisar el flujo real de Centr en GoHighLevel y validar que el modelo v5.0 no reflejaba con suficiente fidelidad la operación comercial. **Adicionalmente, esta versión integra dos cambios documentales que en v5.0 vivían fuera de la doctrina:** (a) el flujo nuevo de Shopify post 1-ene-2026 (Dev Dashboard + client_credentials grant + Custom Apps con acceso automático a Protected Customer Data) que v5.0 documentaba solo en CLAUDE.md como "delta operativo" — ahora vive en Secciones 2.1, 3.1 y 3.6 de la doctrina como modelo principal; (b) la duplicación de CLAUDE.md, ERRORES.md y UX-FIXES.md en Sección 10 (10.1, 10.2, 10.3) fue eliminada en v5.1 — la doctrina ahora apunta a los archivos vivos del repo sin duplicar su contenido, mientras que la Sección 10.4 conserva el formato y ejemplos ilustrativos como referencia.
>
> 1. **Clasificación lead vs cliente en entidad Contacto** — derivación automática (no campo manual): un contacto es **lead** si vive solo en Whaapy (sin `shopify_customer_id`) y **cliente** si tiene identidad Shopify enlazada. No es estado editable; es propiedad derivada que la pestaña Contactos y filtros consumen para badge y para agrupación. Materialización concreta (columna calculada, vista, derivación in-app) queda delegada a Claude Code.
>
> 2. **Sincronización Shopify ↔ Whaapy ya NO es 100% bidireccional simétrica** — modelo asimétrico: creación Shopify → Whaapy es automática (customer nuevo en Shopify dispara creación en Whaapy si no existe contraparte); creación Whaapy → Shopify es **manual on-demand** vía botón "Crear contacto en Shopify" (modal con campos editables antes de invocar API saliente). Updates de campos cuando el contacto existe en ambos sistemas siguen siendo automáticos bidireccionales — la asimetría aplica únicamente al evento de creación. Razón: la mayoría de contactos que entran a Whaapy sin contraparte Shopify son leads que aún no han comprado; crear cada uno en Shopify automáticamente satura el customer base con leads no calificados.
>
> 3. **Pipeline Funnel Venta — 9 etapas (reemplaza las 7 de v5.0)** — refleja el proceso comercial real de Centr en GoHighLevel: Lead nuevo (inicial) → Contactado asesor → Contacto calificado → Reunión agendada → Diseño de espacios → Cotización (llegada automática desde Shopify Draft Order) → Seguimiento para cierre → Ganada (automática al recibir webhook `orders/paid`) → Perdida (requiere motivo). Funnel Post-venta queda intacto.
>
> 4. **Auto-creación de oportunidades — Modelo C2** — POST-backfill, dos disparadores crean automáticamente oportunidad en etapa "Lead nuevo" del Funnel Venta: (a) contacto nuevo entra a Whaapy por primera vez en la base maestra; (b) contacto existente vuelve a interactuar en Whaapy después de N días sin actividad (default N=30, configurable por el admin desde la pantalla de Reglas). Asesor de la oportunidad se hereda del `assigned_advisor_id` del contacto (asignación nativa Whaapy). Durante el backfill de M11 esta auto-creación está suprimida — el backfill no genera oportunidades sintéticas. El botón manual "Crear oportunidad nueva" en detalle de contacto sigue existiendo para casos especiales (lead capturado fuera de Whaapy, oportunidad adicional sobre contacto activo, etc.).
>
> **Implicaciones cruzadas que requirieron edición en cadena:** Sección 1 (resumen ejecutivo — espejos ya no son "bidireccionales simétricos"), Sección 2.1 (alcance MVP — pipeline 9 etapas, sincronización asimétrica, auto-creación C2, badge lead/cliente en pestaña Contactos), Sección 3.3.0 (navegación Contactos refleja tabla unificada con badge), Sección 3.3.3 (entidad Contacto incorpora derivación lead/cliente), Sección 3.3.4 (entidad Oportunidad documenta auto-creación C2), Sección 3.3.9 (seeds: 9 etapas pre-cargadas del Funnel Venta), Sección 3.3.10 (R3 excepción del match inicial ajustada a flujo asimétrico, nueva R12 sobre auto-creación), Sección 3.3.11 (O11 actualizada con asimetría documentada), Sección 3.6 (integraciones Shopify y Whaapy detallan el flujo asimétrico y el botón manual), Sección 4.2 (flujo operativo refleja sincronización asimétrica y auto-creación).
>
> **Decisiones de modelado que la doctrina delegaba a Claude Code (lead como flag vs columna calculada vs vista, materialización de auto-creación como regla del motor vs servicio dedicado, etc.) se mantienen delegadas** — esta versión documenta el modelo conceptual, no la mecánica concreta.
>
> **Cambios respecto a v4 (v5.0 original, 13 de mayo 2026 — referencia histórica):** 3 ajustes finales pre-M0 aplicados — (1) **Ajuste post-Discovery 2 #14: sincronización bidireccional de contactos**, cambio estructural significativo que reformula el modelo de contactos (base maestra como fuente única de verdad, Shopify y Whaapy como espejos sincronizados), agrega R11 + O11, revierte parcialmente el Ajuste final 5 (Whaapy api_key vuelve a Vault porque ahora se usa para llamadas salientes), reescribe partes sustanciales de M3 y M4, modifica M6 y M11; (2) Ajuste de auditoría #8 segunda iteración (trigger de notificación incorrectamente representativo); (3) Ajuste de auditoría #17 (paréntesis aclaratorio sobre `/api/inngest` aplicado). Detalle completo en `MASTER-DOCUMENT-CHANGELOG.md` Parte V. El **v4 queda inmutable como referencia histórica** post-auditoría externa antes del repaso final del operador. La revisión post-M2 (v5.1) refina el modelo de v5.0 con datos operativos reales — no es retrabajo de la doctrina sino convergencia a la realidad de Centr.

---

## Tabla de contenidos

1. Resumen ejecutivo
2. Alcance MVP
3. Arquitectura técnica
   - 3.1 Stack con versiones fijas
   - 3.2 Principios de organización del código
   - 3.3 Modelo de datos conceptual (incluye plan de milestones M0-M11)
   - 3.4 API endpoints
   - 3.5 Auth flow
   - 3.6 Integraciones externas
   - 3.7 Multi-tenant defensivo
4. UX Flows
5. Identidad visual
7. Roadmap post-MVP
10. Anexos: archivos vivos del proyecto (CLAUDE.md, ERRORES.md, UX-FIXES.md)

> Sección 6 (Contenido de landing page) no aplica — plataforma 100% interna sin landing pública. Nota explicativa al inicio del Roadmap.
>
> **Sección 11 (Prompts modulares por milestone M0-M11) vive en archivo separado:** `CENTR-MILESTONES-v5.md`.

---

## Sección 1 — Resumen ejecutivo

### Qué es

Centr Hub es un **CRM operativo multi-tenant** construido específicamente para distribuidores B2C que venden vía Shopify y atienden por WhatsApp Business. **Sustituye totalmente** la combinación actual de **GoHighLevel + Excel manual** que utiliza Centr — no es alternativa, es reemplazo. Post-launch, los vendedores **dejan de usar GHL y Excel** para atribución de ventas, reportes semanales y reportes de comisiones; todo se opera desde Centr Hub. La plataforma cubre las cuatro funciones que hoy se replican entre GHL, Excel y la edición manual entre sistemas:

1. **Atribución de venta:** hoy el vendedor marca la oportunidad como ganada con el monto correcto en GHL para que cuente como suya. En Centr Hub, la atribución es automática vía tags de Shopify (parser de M3) — sin doble registro manual.
2. **Reportes semanales de ventas por vendedor:** hoy se preparan a mano en Excel. En Centr Hub, los exporta el dashboard contextual (M10) con un click.
3. **Reportes de comisiones:** hoy se calculan a mano en Excel desde los Excels semanales. En Centr Hub, el monto vendido por vendedor está en el dashboard; el cálculo de comisión (porcentaje sobre ese monto) queda implícito en la exportación o como columna calculada.
4. **Edición unificada de contactos en tres sistemas** (Ajuste post-Discovery 2 #14, refinado en v5.1): hoy Centr edita el mismo dato manualmente en Shopify, Whaapy y Excel (nombre, teléfono, dirección, etc.). En Centr Hub, la base maestra vive en la plataforma; Shopify y Whaapy son espejos sincronizados con **modelo asimétrico en creación** (Shopify → Whaapy automática; Whaapy → Shopify manual vía botón) y **simétrico en updates** (cambios de campos cuando el contacto existe en ambos sistemas se propagan automáticamente en ambas direcciones). El vendedor edita donde le sea conveniente y la sincronización propaga transparentemente.

Esta sustitución total es **decisión confirmada por Centr en Discovery 2** (respuesta 1.1) + repaso final pre-M0 del operador (Ajuste #14). La capacitación inicial de vendedores y admin debe enfatizar estos cambios explícitamente.

### Para quién

- **Tenant 1 — Centr:** distribuidor oficial CENTR x HYROX en México. Plan Shopify Grow, 990 customers actuales, B2C.
- **Tenant 2 — Rustr (futura):** línea paralela del mismo grupo. Se incorpora en V2 sin retrabajo de schema (multi-tenant desde día 1).
- **Usuarios:** Superadmin (VADAI), Admin (Centr/Rustr), Vendedor.

### Cómo gana dinero el cliente

Centr Hub es una **plataforma interna**. No genera revenue propio: mejora la eficiencia operativa de Centr al automatizar seguimiento, eliminar Excels paralelos, y dar visibilidad consolidada en tiempo real. El revenue de Centr se sigue generando en Shopify y la plataforma lo refleja para reporting.

### Propuesta de valor diferencial

> Centr Hub trata a Shopify como **fuente operativa**, no como integración secundaria. Las Draft Orders son las oportunidades, las tags asignan al vendedor automáticamente, y un Funnel 2 separado opera como Customer Success — algo que ningún CRM comercial (GHL, HubSpot, Pipedrive, Close, Monday) hace nativamente al mismo tiempo.

Los cinco elementos que componen el diferenciador:

1. **Shopify como source of truth operativa** — Draft Orders y Orders son las entidades sobre las que vive el pipeline, no copias derivadas.
2. **Atribución automática por tags** — el vendedor que cierra entra como asignación automática sin intervención manual, vía parser configurable.
3. **Pipeline dual** — Funnel 1 (Venta, KPIs comerciales) + Funnel 2 (Post-venta, KPIs operativos como Customer Success).
4. **Motor de automaciones pre-configurado** para los tres dolores recurrentes que Centr nombró explícitamente en Discovery 1: clientes sin seguimiento, leads olvidados, cotizaciones que se enfrían.
5. **Multi-org con branding propio** — Centr y Rustr comparten plataforma, cada una con su logo + algunos colores propios, mismo estilo general.

### Volumen estimado

| Métrica | Estimación inicial | Implicación de escala |
|---|---|---|
| Tenants en MVP | 2 (Centr + Rustr) | Volumen ligero, no requiere sharding ni particionamiento |
| Contactos por tenant | ~1,000-2,000 (Centr arranca con 990) | Volumen estándar de BD, sin optimizaciones agresivas |
| Draft Orders/mes | 50-150 | Pipeline kanban absorbe volumen sin desempeño limitado |
| Orders/mes | 30-80 | Reportería se ejecuta directo contra BD sin sufrir |
| Usuarios concurrentes | 5-15 por tenant | Real-time sin riesgo de saturación |
| Webhooks Shopify/día | ~20-50 | Rate limits del plan Grow sobrados |

*Las estimaciones de volumen son asunciones razonables para B2C de equipo deportivo en México; si Discovery 2 (Bloque 4) revela >1,000 orders/mes, se revisita la estrategia de paginación en los milestones de pipeline y reportes.*

---

## Sección 2 — Alcance MVP

### 2.1 Features incluidas

**1. Autenticación y multi-organización**
Supabase Auth con Email/Password + Magic Link como fallback. Un usuario puede pertenecer a múltiples organizaciones (típicamente solo el superadmin de VADAI). Invitación de vendedores nuevos por email con activación de contraseña.

**2. Sincronización con Shopify**
App creada en Shopify Dev Dashboard (`partners.shopify.com`) e instalada por organización vía OAuth (modelo Custom App del Dev Dashboard, no Custom App clásica que Shopify retiró el 1-ene-2026). Admin GraphQL API v2026-04. Credenciales: Client ID + Client Secret de la app; `access_token` por tienda se obtiene en runtime vía **client_credentials grant** y se cachea en Vault. Webhooks firmados con HMAC-SHA256 usando Client Secret como signing key (no hay secret separado de webhooks). Webhooks consumidos: 3 de customers + 3 de draft_orders + 6 de orders (lista completa en Sección 3.6). Idempotencia con dedup. Procesamiento async. Last-write-wins a nivel registro. Backfill inicial vía Bulk Operations. **Custom Apps del Dev Dashboard tienen acceso automático a Protected Customer Data Levels 1 y 2 (`read_customers`, `write_customers`) y a `read_all_orders` al instalarse** — el consentimiento del merchant se otorga al aprobar los scopes durante la instalación, sin trámite externo (diferencia con apps publicadas en el App Store, que sí requieren formularios).

**3. Sincronización con Whaapy — contactos, con asimetría en creación**
La sincronización de contactos con Whaapy es **asimétrica en creación, simétrica en updates** (Ajuste post-Discovery 2 #14 + revisión v5.1). La base maestra de contactos vive en la plataforma; Shopify y Whaapy son espejos sincronizados. Webhooks consumidos: `contact.created`, `contact.updated`, `contact.deleted`, y el evento que Whaapy provea para asignación de asesor (la sesión de M4 decide cuál según docs actuales). **NO se sincronizan mensajes ni conversaciones** — el vendedor opera todas las conversaciones desde el iframe de Whaapy embebido en la plataforma (pestaña Whaapy), no necesita una vista nativa de mensajes.

**Direcciones de propagación:**
- **Shopify → Whaapy (creación automática):** customer nuevo en Shopify dispara creación en Whaapy si no existe contraparte (vía teléfono normalizado).
- **Whaapy → Shopify (creación manual on-demand):** un contacto nacido en Whaapy NO se crea automáticamente en Shopify. El vendedor o admin lo crea explícitamente desde el botón "Crear contacto en Shopify" (visible en detalle de oportunidad y detalle de contacto), que abre modal con campos editables antes de invocar la API saliente. Razón: la mayoría de contactos que entran a Whaapy sin contraparte Shopify son leads no calificados; crear cada uno automáticamente en Shopify satura el customer base.
- **Updates de campos en contactos existentes en ambos sistemas:** propagación automática bidireccional (último cambio gana por campo — R3).

**Llamadas salientes a Whaapy:** la plataforma invoca la API saliente de Whaapy para crear contactos cuando llegan customers nuevos de Shopify sin contraparte Whaapy, actualizar contactos con cambios propagados, y asignar contactos al `whaapy_agent_id` mapeado cuando el asesor cambia desde otra fuente. Whaapy api_key cifrado en Supabase Vault.

**Llamadas salientes a Shopify para creación de contacto:** disparadas exclusivamente desde el botón "Crear contacto en Shopify" en M6 (detalle de contacto u oportunidad). Si el match por teléfono normalizado encuentra customer Shopify existente, **no se duplica** — solo se enlaza la identidad faltante (`shopify_customer_id`) al maestro, con mensaje al vendedor indicando que el customer ya existía.

**Razones del alcance:** la plataforma resuelve el dolor central de Centr de mantener el mismo dato en tres sistemas (Shopify, Whaapy, Excel). El vendedor edita donde le sea conveniente; la sincronización propaga transparentemente. LWW por campo con borrados intencionales propagados (R3 refinada). Defensa anti-bucle obligatoria desde el primer commit (R11). Auto-creación de oportunidades en Whaapy modulada por R12 (modelo C2).

Identity matching contra contactos Shopify existentes por teléfono E.164 normalizado y email normalizado (lowercase + trim). No se descarga media — esos archivos viven en Whaapy y se ven a través del iframe.

**4. Pipeline kanban dual**
Toggle "Venta / Post-venta" en header. Funnel 1 con **9 etapas pre-cargadas** (modelo refinado en v5.1 con base en el proceso real de Centr en GoHighLevel — ver 3.3.9), Funnel 2 con 6 etapas pre-cargadas, todas editables por admin. Drag-and-drop entre etapas con feedback optimista. Virtualización cuando una etapa supera 50 cards. Paginación server-side. Real-time selectivo de updates entre vendedores en la misma vista.

**Auto-creación de oportunidades en "Lead nuevo" — Modelo C2** (v5.1): POST-backfill, dos disparadores crean oportunidad automática en la etapa inicial del Funnel Venta:
- Contacto nuevo entra a Whaapy (primera vez que aparece en la base maestra).
- Contacto existente vuelve a interactuar en Whaapy después de N días sin actividad (default N=30, configurable por el admin desde Reglas).

El asesor de la oportunidad se hereda del `assigned_advisor_id` del contacto (asignación nativa Whaapy). Durante el backfill de M11 esta auto-creación se suprime. El botón manual "Crear oportunidad nueva" en detalle de contacto sigue existiendo para casos especiales (lead capturado fuera de Whaapy, oportunidad adicional sobre contacto activo, etc.). Reglas operativas concretas en R12.

**5. Atribución automática de vendedor (parser de tags)**
Servicio que lee `tags` de Customer/DraftOrder/Order, normaliza (lowercase + trim), consulta el mapeo configurado por el admin, y asigna el vendedor correspondiente cuando la tag está clasificada como `vendor`. Cada entidad mantiene su asignación independiente. Tags clasificadas como `informational` (la mayoría — `"FACTURADA"`, `"VIP"`, `"+30KG"`, etc.) se conservan en la entidad sin disparar atribución. Edge cases manejados explícitamente: múltiples tags clasificadas como `vendor` en misma entidad (anomalía con alerta in-app al admin), tag de vendedor mapeada a vendedor desactivado (asignación queda nula y log).

**Ejemplos reales conocidos de tags operacionales de Centr** (Discovery 2 respuesta 1.5): `"Anticipo 50%"` (estado financiero), `"C2"` (Concept2, producto en otro almacén), `"Factura"` y `"Facturado"` (estado de facturación). Estas tags son **informativas** — NO se mapean a vendedores; se reflejan en la oportunidad como información valiosa para el vendedor (saber que hay anticipo, ubicación de almacén, etc.) pero NO disparan lógica de atribución. Las tags de vendedor (nombres de personas como "GinaJimenez", "LauraVega") son las únicas que el admin clasifica explícitamente como `vendor` en M7.

**6. Trigger automático Funnel 1 → Funnel 2**
Cuando llega webhook `orders/paid` y la oportunidad de Funnel 1 ligada pasa a etapa con `is_won = true`, se crea automáticamente una oportunidad nueva en Funnel 2, primera etapa con `is_initial = true`, heredando contacto y asesor. La oportunidad de Funnel 1 NO se altera. **Operación atómica para garantizar consistencia** — la creación de la oportunidad hija y la marca de ganada en la original deben aplicarse juntas o no aplicarse. Toast de feedback al usuario: "Oportunidad ganada. Se creó seguimiento en Post-venta."

**7. Motor de reglas configurable**
8 triggers (`stage_aging`, `no_activity`, `created`, `stage_changed`, `won`, `lost`, `contact.created`, `contact.no_activity`), 7 condiciones (monto, etapa, tags, asesor, tiempo en etapa, día de semana, hora del día), 5 acciones (`create_task`, `notify_advisor`, `notify_admin`, `move_to_stage`, `add_tag`). Wizard de 3 pasos para crear/editar reglas. **4 reglas core pre-cargadas activas desde el primer login + 2 reglas opcionales inactivas.** Circuit breaker para evitar loops. Ejecuciones logueadas para auditoría. Evaluación por triggers de eventos en línea + evaluación periódica cada hora para triggers de aging / no_activity.

**8. Módulo de Metas**
Metas mensuales, trimestrales y anuales por vendedor y por organización global. Editables en cualquier momento (Centr confirmó que sus metas cambian frecuentemente). Histórico de periodos pasados visible. Umbrales de semáforos configurables con defaults razonables (cobertura: ≥3x verde, 2-3x amarillo, <2x rojo / cumplimiento: ≥100% verde, 90-99% amarillo, <90% rojo). Aplica únicamente a Funnel 1.

**9. Pestaña "Mi Día"**
Vista visual de pendientes priorizada (Linear/Sunsama-style), no lista plana. Header con 4 indicadores grandes (Atrasadas, Hoy, Pipeline en juego, Completadas hoy), cards centrales agrupadas por urgencia y ordenadas dentro de cada grupo por monto en juego, sidebar con widgets contextuales (Clientes silenciosos, Tu semana, Meta del mes, Racha). Real-time. Admin tiene toggle "Mis Pendientes / Vista equipo".

**10. Dashboard y reportes**
Vista Vendedor y vista Admin, separadas por funnel (toggle Venta/Post-venta). KPIs calculados contra la BD interna, nunca contra Shopify directo (decisión arquitectónica de Sección 3.6). Filtros por periodo, vendedor, etapa, producto. Exportación Excel + PDF en dos estilos: crudo numérico (replica los Excels actuales de Gina, solo tablas) y visual (replica del dashboard con gráficas, semáforos y formato presentable). Reportes generales y por vendedor, semanales y mensuales. Branding aplicado (logo y colores del tenant activo, header, footer con número de página).

**11. Configuración por administrador**
Pantallas dedicadas (no archivos de configuración): etapas de cada funnel (CRUD + reorder), reglas de automación, metas, umbrales de semáforos, motivos de pérdida, mapeo de tags ↔ vendedor, usuarios (invitar/desactivar), branding por org.

**12. Cumplimiento ARCO básico**
Aviso de privacidad linkado en login. Proceso de "borrado" implementado como anonimización (nombre → "Cliente anonimizado #{id}", email y phone borrados, audit log conservado). Solo admin puede ejecutar. Log de la solicitud y la ejecución.

### 2.2 Features explícitamente excluidas

| Feature | Razón de exclusión | Futureproofing en MVP |
|---|---|---|
| **Módulo de Reuniones (Google Calendar/Outlook)** | Centr lo descartó del MVP, marcado como V2 tentativo *(Research v6 changelog v5→v6)* | El schema deja espacio para una entidad de reuniones y una referencia nullable desde oportunidades. No se implementa pero queda preparado el diseño |
| **Templates de WhatsApp** | Gestionados por otro equipo, no responsabilidad de la plataforma | El sistema de notificaciones ya soporta acciones del motor de reglas; en V2 se agregaría una acción adicional `send_template_message` sin retrabajo del core |
| **Agente de IA conversacional** | Fuera de scope MVP, posible V2 si Centr lo pide | Sin reservar nada en schema; V2 agregaría entidades dedicadas sin tocar core |
| **Marketing tracking / attribution** | Centr lo sigue manejando manualmente, fuera de scope | Sin reservar nada en schema; V2 agregaría una entidad ligada a contactos sin tocar core |
| **B2B / Companies** | Centr confirmó B2C only y no contempla B2B | Sin reservar nada en schema; V2 agregaría una entidad de companies + referencia nullable desde contactos |
| **App nativa** | Responsive web día 1; PWA en V2 | Responsive desde día 1 cumple el requisito; PWA es feature de Next.js que se habilita sin retrabajo |
| **Pagos en línea (Stripe)** | Los pagos viven en Shopify, plataforma solo refleja `financial_status` | No requerido en MVP. Si V2 necesita facturación interna, se agrega en módulo separado |
| **Notificaciones por email/SMS** | Solo in-app en MVP | Las notificaciones ya están modeladas como entidad; V2 agrega canales adicionales sin tocar la lógica de generación |
| **Migración histórica de GHL** | Arrancar limpio, decisión cerrada en Discovery 1 | El campo `source_origin` considera un valor para migración GHL; script único de migración se construiría en V2 si Centr cambia de opinión, sin tocar core |
| **Multi-canal (Instagram, Facebook Messenger)** | WhatsApp único en MVP | Tabla puente posible en V2; el modelo actual no lo bloquea |
| **Sub-organizaciones / equipos dentro de un tenant** | 2 orgs planas (Centr + Rustr) suficiente | El modelo multi-tenant ya soporta org-as-team con roles; granularidad mayor no requerida |

### 2.3 Verticales target

**Vertical primaria:** distribución B2C de equipo deportivo / fitness en México (Centr — equipo HYROX).

**Vertical secundaria (V2):** segunda línea del mismo grupo (Rustr). Sin definición exacta del nicho aún; arquitectura multi-tenant lo absorbe sin cambios.

**Verticales potencialmente adoptables sin retrabajo mayor:** cualquier distribuidor B2C que opere en Shopify + WhatsApp con tags como atribución de vendedor. Centr Hub no se reposiciona como SaaS comercial en MVP, pero la arquitectura técnica no lo bloquea.

---

## Sección 3 — Arquitectura técnica

### 3.1 Stack con versiones fijas

> **Regla absoluta:** versiones pinneadas en `package.json`. Nada de `@latest` ni rangos `^` en dependencias críticas. Lección Kibah documentada en Playbook v6 F5.

**Frontend y framework:**

| Paquete | Versión | Notas |
|---|---|---|
| `next` | `14.2.x` | NO 15+. App Router obligatorio. `next.config.mjs` (no `.ts`) |
| `react` | `18.3.1` | Pinneado exacto |
| `react-dom` | `18.3.1` | Pinneado exacto |
| `typescript` | `5.4.x` | `strict: true` obligatorio |
| `tailwindcss` | `3.4.x` | Config con design tokens de branding por org |

**UI y diseño:**

| Paquete | Versión | Uso |
|---|---|---|
| `shadcn/ui` | (no versión, copia componentes) | Base de UI; calibración default + ajustes Centr |
| `lucide-react` | `0.383.x` | Iconos consistente con stack VADAI |
| `class-variance-authority` | `0.7.x` | Variants en componentes |
| `tailwind-merge` | `2.x` | Composición de clases |
| `next-themes` | `0.3.x` | Dark mode toggle |

**Estado, datos y validación:**

| Paquete | Versión | Uso |
|---|---|---|
| `@supabase/supabase-js` | `2.x` (última estable a fecha de M0) | Cliente Supabase |
| `@supabase/ssr` | `0.x` (última estable) | Auth helpers para App Router con cookies async |
| `zod` | `3.23.x` | Validación en cada API route, server action y service |
| `@tanstack/react-query` | `5.x` | Cache de datos en cliente cuando aplique |

**Funcionalidad específica del producto:**

| Paquete | Versión | Uso |
|---|---|---|
| `@dnd-kit/core` | `6.1.x` | Drag and drop del pipeline kanban |
| `@dnd-kit/sortable` | `8.x` | Listas ordenables |
| `@tanstack/react-virtual` | `3.x` | Virtualización cuando >50 cards en etapa |
| `recharts` | `2.12.x` | Gráficas del dashboard |
| `luxon` | `3.x` | Fechas y zonas horarias (America/Mexico_City por default) |
| `libphonenumber-js` | `1.x` | Normalización a E.164 para identity matching |
| `jspdf` | `2.5.x` | Generación de PDFs (reportes) |
| `xlsx` (SheetJS) | `0.20.x` | Generación de Excel (reportes) |

**Workers, jobs y eventos:**

| Servicio | Notas |
|---|---|
| `inngest` (SDK `3.x`) | Workers, crons, retries. **Todos los crons viven aquí** — Vercel solo sirve la app |
| `@upstash/redis` (SDK `1.x`) | Dedup de webhooks (`SETNX EX`) y cache puntual |

**Backend gestionado:**

| Servicio | Plan / nivel | Notas |
|---|---|---|
| Supabase | Pro (o el plan que requiera el volumen de M0+) | Postgres + Auth + Storage + Realtime + Vault |
| Vercel | **Free** | **Repo público de GitHub obligatorio (limitación del tier free).** Sin secrets ni credenciales en código (refuerzo de regla general). Crons y funciones >10s migrados a Inngest (limitaciones del tier free). Si en el futuro se justifica migrar a PRO, se hace entonces — el patrón "crons en Inngest" se mantiene como decisión arquitectónica independiente del tier de Vercel |
| Inngest | Hobby/Pro según volumen | **Todos los crons del proyecto + funciones de procesamiento >10s** (workers de webhooks, exports de PDF visual pesados). Cobertura central de tareas async |
| Upstash Redis | Free tier inicial, monitoreo de uso | Dedup + cache |

**Integraciones externas:**

| Servicio | API Version |
|---|---|
| Shopify Admin | GraphQL `2026-04` |
| Whaapy | API actual; webhooks v1 |

### 3.2 Principios de organización del código

La estructura concreta de carpetas y archivos la define Claude Code en M0 al inicializar el proyecto. Lo que sí queda definido en el Master Document son los principios que esa estructura debe cumplir:

- **Separación capa de datos / capa de negocio / capa de presentación.** Toda query a Supabase debe pasar por una capa de acceso a datos dedicada, separada de los componentes y rutas. La lógica de negocio (parser de tags, identity matching, trigger F1→F2, motor de reglas, last-write-wins) vive en una capa de servicios que consume la capa de datos. La UI no consulta directo a Supabase ni implementa reglas de negocio.
- **Validación con Zod obligatoria** en cada API route, server action y servicio que reciba input externo (incluidos los handlers de webhooks).
- **Constantes centralizadas**, no esparcidas en el código. ENUMs, defaults, umbrales y configuración base viven en un único lugar consultable.
- **Server Components por default** en App Router. `'use client'` solo cuando se requiera interactividad/estado.
- **Archivos <300 líneas** (regla del Playbook v6). Si un archivo crece más, se refactoriza en sub-módulos.
- **Aislamiento de credenciales sensibles**: la `service_role_key` de Supabase nunca se importa ni se referencia desde código que pueda ejecutarse en el navegador.
- **Tipos generados desde la BD**: los tipos TypeScript de las entidades se generan automáticamente desde el schema de Supabase para mantener sincronía. Los tipos custom se construyen sobre esos.

### 3.3 Modelo de datos conceptual

> Esta sección describe **qué entidades existen**, **qué información llevan**, **cómo se relacionan**, y **qué reglas de integridad de negocio aplican**. NO incluye tipos de datos, nombres exactos de columnas, FKs, constraints de BD, índices ni RLS policies — todo eso lo decide Claude Code en M1 al traducir este modelo a schema SQL ejecutable. El principio defensivo multi-tenant (RLS + barrera en aplicación) se documenta en Sección 3.7.
>
> El plan de descomposición de trabajo (M0-M11) que materializa este modelo vive en la subsección 3.3.0 al inicio de esta sección.

#### 3.3.0 Plan de milestones — vista de alto nivel

##### Principios de descomposición aplicados

1. **Decisiones temprano, deploy temprano** — M0 deja el deploy base funcionando antes de cualquier feature.
2. **Cada milestone es autocontenido y demostrable** — al cierre del milestone hay algo que se puede mostrar (URL, flujo, dato visible en la BD, archivo descargable).
3. **Capacidades incrementales** — los milestones se ordenan de modo que cada uno desbloquea capacidad real de usuario, no solo "fundación interna invisible". M1 es la única excepción intencional (fundación pura, sin UI demostrable).
4. **Componentes de alto riesgo identificados** y marcados con `⚠️ CHECKPOINT` — al terminar ese milestone se valida manualmente antes de avanzar (Playbook v6 F6). Aplica a: parser de tags y last-write-wins (M3), pipeline kanban con drag-and-drop (M5), iframe Whaapy (M6), trigger atómico F1→F2 (M7), motor de reglas (M8).
5. **Diseño tarde, no durante** — los milestones M2-M11 se entregan con UI funcional pero no pulida. F7 (sesión dedicada de diseño) procesa todo el `UX-FIXES.md` acumulado. Esta división está explícitamente alineada con el patrón "diseño tarde" del Playbook v6.
6. **Scope cerrado por milestone** — si Claude Code identifica un cambio que afecta archivos fuera del scope listado, debe pausar y preguntar antes de avanzar.

##### Navegación principal de la plataforma

La estructura de pestañas que los milestones construyen incrementalmente.

**Pestañas del vendedor:**

| Pestaña | Construida en | Notas |
|---|---|---|
| **Pipeline** | M5 | Toggle Venta/Post-venta. Drag-and-drop entre etapas |
| **Mi Día** | M9 | Vista visual de pendientes priorizada (no lista plana) |
| **Contactos** | M6 | **Tabla unificada leads + clientes con badge** (v5.1). Un registro por contacto con sus identidades enlazadas; los que existen en ambos sistemas se ven como un solo registro, los que existen solo en uno aparecen igual. Columnas: badge tipo (lead/cliente — derivado de presencia de `shopify_customer_id`), nombre, teléfono, email, asesor asignado, última actividad, top 2-3 tags. Filtros: toggle solo-leads/solo-clientes/todos, búsqueda por nombre/teléfono/email, filtro por asesor, filtro por sin-actividad-X-días. Orden default por última actividad descendente. El vendedor ve solo sus asignados; el admin ve todos. |
| **Whaapy** | M6 | Iframe de Whaapy embebido en pestaña dedicada |
| **Dashboard** | M10 | **Incluye exportación contextual.** Los reportes son la versión exportable del dashboard que el usuario está viendo (mismos filtros aplicados) — no hay pestaña separada de "Reportes" |

**Sección de administración (acceso solo para rol admin):**

| Sub-página | Construida en |
|---|---|
| Etapas del pipeline (por funnel) | M7 |
| Motivos de pérdida | M7 |
| Mapeo de tags ↔ vendedor | M7 |
| Reglas de automación | M8 |
| Metas | M10 |
| Umbrales de semáforos | M10 |
| Usuarios (invitar/desactivar vendedores) | M11 |
| Branding de la organización | M11 |

F7 decide visualmente cómo se agrupa la sección admin (sidebar dedicado, tabs, secciones colapsables). No es bloqueante para los milestones funcionales.

##### Tabla maestra de milestones

| # | Milestone | Capacidad entregada al cierre | Riesgo |
|---|---|---|---|
| **M0** | Infraestructura base | Repo + Vercel + Supabase + Inngest + Upstash conectados; "Hello World" en producción | Bajo |
| **M1** | Fundación de datos y multi-tenant | Schema completo en BD, RLS activo, contexto de tenant funcional, capa de datos y servicios base lista | Medio (estructural) |
| **M2** | Auth + multi-organización | Vendedor invitado vía SQL puede entrar, ver layout autenticado vacío, salir | Bajo |
| **M3** | Sincronización Shopify (webhooks + parser de tags) | Una Draft Order creada en Shopify aparece como oportunidad en la BD con vendedor asignado | **Alto** ⚠️ |
| **M4** | Sincronización Whaapy + identity matching | Un contacto nuevo en Whaapy se sincroniza y se matchea con contacto Shopify por teléfono/email | Medio |
| **M5** | Pipeline kanban dual | Vendedor ve sus oportunidades en kanban, drag-and-drop entre etapas funciona, toggle Venta/Post-venta opera | **Alto** ⚠️ |
| **M6** | Vista de contacto y oportunidad + iframe Whaapy | Detalle de contacto con su timeline consolidado, detalle de oportunidad, iframe Whaapy embebido y funcional | **Alto** ⚠️ |
| **M7** | Trigger F1→F2 + administración de etapas, motivos y mapeo de tags | Admin configura etapas, motivos de pérdida y mapeo tags↔vendedor. Webhook `orders/paid` mueve a Ganada y crea oportunidad hija en F2 automáticamente | **Alto** ⚠️ |
| **M8** | Motor de reglas configurable | Admin crea/edita reglas. Reglas pre-cargadas operan desde el primer login. Tareas y notificaciones se generan automáticamente | **Alto** ⚠️ |
| **M9** | Mi Día + notificaciones en tiempo real | Vendedor ve su pantalla Mi Día con cards priorizadas; notificaciones nuevas aparecen sin reload | Medio |
| **M10** | Metas + dashboard con exportación contextual | Admin define metas. Dashboard muestra KPIs por funnel con semáforos. Exportación respeta los filtros aplicados | Medio |
| **M11** | ARCO + branding multi-org + backfill + hardening | Admin ejecuta anonimización ARCO. Branding por org aplicado. Backfill inicial ejecutado. Smoke tests end-to-end con datos reales | Medio |

##### Dependencias visuales del plan

```
M0 → M1 → M2 → M3 → M4
                ↓    ↓
                M5 ←─┘
                ↓
                M6
                ↓
                M7
                ↓
                M8
                ↓
                M9
                ↓
                M10
                ↓
                F7 (diseño, procesa UX-FIXES.md)
                ↓
                M11 (cierre)
```

M3 y M4 pueden trabajarse en paralelo conceptualmente (Shopify y Whaapy son independientes), pero M4 valida identity matching contra contactos de Shopify, por lo que M3 debe estar funcional primero (al menos webhook customers operando). M5 depende de M3 (oportunidades vienen de Shopify draft_orders).

##### F7 — Sesión de diseño y pulido visual (no es milestone funcional)

F7 no es un milestone numerado porque no agrega capacidad funcional nueva — es **polish visual sobre todo lo que M2-M10 ya construyó funcionalmente**. Se ejecuta entre M10 y M11. Procesa todo el `UX-FIXES.md` acumulado durante M2-M10.

**Cuatro sub-sesiones agrupadas (Playbook v6 F7):**

| Sesión | Alcance |
|---|---|
| **A — Públicas / login** | Hero de login, magic link, aviso de privacidad, animaciones de entrada, dark mode pulido |
| **B — Layout / dashboard** | Sidebar, top bar, navegación entre pestañas, espaciado consistente, tipografía, branding por org afinado |
| **C — Componentes funcionales** | Pipeline kanban (cards, hover states, transiciones de drag), Mi Día (microinteracciones, racha gamification), Contactos, modales, estados (empty, skeleton, error) |
| **D — Admin / configuración** | Pantallas de admin, wizard de creación de reglas (3 pasos) |

**Componentes de alto riesgo en F7:** mismo principio que F6 — si la sesión toca el iframe Whaapy, el drag-and-drop del pipeline, o las gráficas del dashboard, checkpoint manual antes de avanzar al siguiente componente.

##### Antigravity Skills activas durante todo el proyecto

Documentadas en CLAUDE.md (Sección 10 de este documento) con detalle de cuándo invocar cada una:

- **GSD** — al inicio de cada milestone.
- **Supabase Developer** — milestones que tocan BD (M1, M3, M4, M5+).
- **Next.js Supabase Auth** — M2 + middleware de tenant context en M1.
- **Vercel React Best Practices** + **Vercel Composition Patterns** — milestones con UI sustantiva (M2, M5, M6, M7, M9, M10).
- **UI/UX Pro Max** — SOLO en F7.

**Stripe Upgrade NO aplica** — sin Stripe en MVP.


#### 3.3.1 Principios del modelo

1. **Multi-tenant por construcción.** Toda entidad con datos operativos pertenece a una organización. Las entidades del catálogo de la plataforma (ej. motivos de pérdida, etapas) también son por organización — Centr y Rustr pueden tener catálogos distintos.

2. **Last-write-wins a nivel registro.** Las entidades sincronizadas con sistemas externos llevan al menos tres metadatos de origen: cuándo se modificó por última vez, qué sistema fue la última fuente (Shopify, Whaapy, plataforma), y de qué origen se creó. El sistema gana siempre el timestamp más reciente.

3. **Asignación independiente por entidad.** Contactos, oportunidades y órdenes tienen su propio asesor asignado. Pueden coincidir o divergir según la fuente externa que los asignó (Whaapy para contactos, tags de Shopify para oportunidades y órdenes). No hay reconciliación automática entre entidades.

4. **Soft delete donde corresponde.** Borrados externos se marcan con flag ("eliminado en sistema X") y se conserva histórico. La plataforma nunca pierde data por una decisión externa irreversible.

5. **Catálogos editables, no enums.** Cuando el admin necesita editar el catálogo (motivos de pérdida, etapas, tags), la información vive en entidades dedicadas referenciables, no en enums de BD. Permite renombrar sin perder histórico y desactivar sin borrar.

6. **Identidad consolidada del contacto.** Un contacto en la plataforma es un único registro consolidado que puede tener N identidades en sistemas externos (Shopify customer ID, Whaapy contact ID). La pestaña Contactos muestra un registro por contacto, no por identidad.

7. **Auditabilidad.** Cada cambio relevante (movimiento de etapa, ejecución de regla, anonimización ARCO, operación de admin sobre catálogos) deja huella en un log inmutable.

#### 3.3.2 Grupo A — Multi-tenancy

**Organización**
Entidad raíz del modelo multi-tenant. Representa un tenant operativo de la plataforma (Centr, Rustr futura). Cada organización tiene su catálogo, sus usuarios, sus reglas, su branding y sus credenciales de servicios externos.

*Información relevante:* nombre, URL pública del Shopify store conectado, business ID del Whaapy conectado, configuración de branding (logo, colores, etc.), bloque de configuración operativa (umbrales de semáforos, defaults), referencia a las credenciales cifradas almacenadas en Supabase Vault.

*Relaciones:* todas las demás entidades operativas pertenecen a una organización (1..N descendente).

*Reglas de integridad:* el `shopify_store_url` debe ser único globalmente (cada tienda Shopify mapea a una sola organización). El `whaapy_business_id` también. Las credenciales sensibles **nunca** se almacenan en este registro directamente — solo referencia a Supabase Vault.

**Usuario**
Persona con acceso a la plataforma. Cada usuario corresponde a un registro en `auth.users` de Supabase Auth. La plataforma extiende esa identidad con metadata específica (nombre completo, teléfono opcional, avatar, color asignado para representación visual cuando aplique como vendedor).

*Atributos del usuario como vendedor (cuando aplique):* meta personal por periodo (vive en la entidad de metas, no aquí), referencia a su `whaapy_agent_id` si tiene contraparte en Whaapy, color identificador para la UI.

*Caso especial — usuario sistema "Histórico":* cada organización lleva un usuario sistema llamado "Histórico" creado como seed inicial (M1). Es **contenedor de atribución histórica**, no vendedor real. Lleva un flag `is_system_user = true` (o equivalente que Claude Code decida en M1) que lo distingue de usuarios reales. NO recibe invitación por email, NO puede entrar a la plataforma, NO aparece en dropdowns de asignación manual, NO es elegible para reasignación admin desde la UI. Su única vía de asignación es el backfill (M11). Ver Observación O10 + Regla R10.

*Relaciones:* un usuario puede pertenecer a N organizaciones vía la entidad puente `user_organizations`. Un usuario como vendedor puede tener N contactos, oportunidades, órdenes, tareas y notificaciones asignadas dentro de una organización.

*Reglas de integridad:* la identidad y autenticación se delegan a Supabase Auth — la entidad de usuario de la plataforma extiende, no duplica. Email único globalmente (lo gestiona Supabase Auth). El usuario sistema "Histórico" tiene email genérico tipo `historico@<org-slug>.centrhub.local` (placeholder no real, no recibe correo) — el `<org-slug>` garantiza unicidad global entre organizaciones (Centr, Rustr, cualquier futura) y su membresía está desactivada por default.

**Membresía Usuario ↔ Organización**
Entidad puente que materializa la pertenencia de un usuario a una organización, con un rol específico dentro de ella. El mismo usuario puede pertenecer a varias organizaciones con roles distintos (ej. superadmin en VADAI org, admin en Centr).

*Información relevante:* usuario, organización, rol (uno de tres: superadmin, admin, vendedor — ver decisión de modelado al final del bloque sobre por qué es valor fijo y no entidad), flag de activación (permite desactivar sin borrar), `whaapy_agent_id` opcional cuando ese usuario tiene contraparte en Whaapy de esa organización.

*Relaciones:* N..M entre usuarios y organizaciones. La membresía es la unidad sobre la que se aplican permisos.

*Reglas de integridad:* la combinación usuario + organización es única (un usuario no puede tener dos membresías a la misma organización). Un usuario desactivado en una organización conserva el histórico de sus entidades asignadas (oportunidades, contactos, órdenes), pero no recibe nuevas asignaciones automáticas.

#### 3.3.3 Grupo B — Contactos e identidades

**Contacto**
Persona física a la que Centr vende. La entidad Contacto en la BD de la plataforma es la **base maestra de contactos — fuente única de verdad**. Shopify y Whaapy son sistemas externos espejados; la plataforma orquesta la sincronización para que los tres sistemas (Shopify, Whaapy, base maestra) se mantengan consistentes (Ajuste post-Discovery 2 #14 + revisión v5.1 — ver Observación O11 + Reglas R11 y R12). Cada contacto maestro tiene columnas `shopify_customer_id` y `whaapy_contact_id` para enlazar las identidades externas; pueden estar ambas, solo una, o ninguna en casos transitorios (contacto recién creado en la plataforma antes de propagar).

**Clasificación lead vs cliente (v5.1) — propiedad derivada, no campo manual.**
Cada contacto pertenece a una de dos categorías derivadas automáticamente de las identidades externas enlazadas:
- **Lead** — contacto sin `shopify_customer_id` (vive solo en Whaapy, o solo en la plataforma sin propagación todavía). Aún no ha comprado en Shopify.
- **Cliente** — contacto con `shopify_customer_id` presente (tiene identidad Shopify enlazada, independiente de si ha hecho compras o solo es un customer registrado con `orders_count = 0`).

Esta clasificación es **derivada en runtime**, no es estado editable ni columna escrita. Cuando un lead se enlaza con identidad Shopify (sea por match automático en sincronización entrante, por uso del botón "Crear contacto en Shopify", o por completar identidades durante backfill) pasa automáticamente a cliente sin operación adicional del usuario. La pestaña Contactos (M6) consume esta propiedad para badge visual y filtros (toggle solo-leads/solo-clientes/todos). **Decisión de modelado delegada a Claude Code en M1:** materializar como columna calculada (`type` = CASE WHEN shopify_customer_id IS NOT NULL THEN 'cliente' ELSE 'lead' END), vista derivada, o derivación in-app — cualquiera de las tres es válida; el principio operativo es el mismo: no se mantiene como flag editable que pueda divergir de la realidad de identidades.

*Información relevante:* nombre completo, email normalizado (lowercase + trim), teléfono normalizado a E.164, dirección principal, nota interna, tags de Shopify conservadas como información (independiente del mapeo a asesor), estado del cliente según Shopify (habilitado/deshabilitado/etc.), asesor asignado, **identificadores externos: `shopify_customer_id` y `whaapy_contact_id`** (nullable cada uno), metadatos de last-write-wins **por campo** (timestamp y fuente — R3 aplicada al contact), flag `missing_phone` cuando el contacto llegó sin teléfono, flag de "borrado en Whaapy" y "borrado en Shopify" para auditoría, marca de anonimización ARCO si aplica, timestamp de última actividad en Whaapy (para evaluar R12 — re-actividad después de N días dispara auto-creación de oportunidad).

*Relaciones:* un contacto puede tener identidades en Shopify, Whaapy, ambas, o ninguna (en casos transitorios). 0..N oportunidades, 0..N órdenes, 0..N tareas, 0..N notificaciones, 0..N actividades en su timeline.

*Reglas de integridad:* el asesor asignado del contacto **se establece según el sistema que origina la asignación y se propaga al resto**:
- **Asignación originada en Shopify** (vía tag de vendedor en `customers/*`): parser de M3 asigna al maestro; M3 propaga a Whaapy vía API saliente (asignación al `whaapy_agent_id` mapeado del vendedor).
- **Asignación originada en Whaapy** (vía regla nativa de Whaapy entregada por webhook — `conversation.assigned` u otro evento equivalente; M4 decide cuál según docs de Whaapy actuales): M4 resuelve el `whaapy_agent_id` contra membresía organizacional; si match, asigna al maestro Y propaga a Shopify vía API saliente **si el contacto ya tiene `shopify_customer_id` enlazado** (agregando la tag mapeada del vendedor al customer); si el contacto es lead (sin identidad Shopify), no hay nada que propagar a Shopify hasta que el botón "Crear contacto en Shopify" enlace la identidad faltante.
- **Edición manual del admin en M6 (detalle de contacto)**: la plataforma actualiza el maestro inmediatamente y propaga a los sistemas externos que tengan identidad enlazada — si hay `shopify_customer_id`, propaga a Shopify; si hay `whaapy_contact_id`, propaga a Whaapy.

**Sincronización asimétrica en creación, simétrica en updates (v5.1):**
- Si el contacto entra desde Shopify y no tiene `whaapy_contact_id`, la plataforma orquesta creación en Whaapy automáticamente (vía API saliente, siempre que `missing_phone = false`).
- Si el contacto entra desde Whaapy y no tiene `shopify_customer_id`, **NO se crea automáticamente en Shopify** — queda como lead hasta que el vendedor/admin use el botón "Crear contacto en Shopify" en M6 (modal con campos editables + match defensivo por teléfono normalizado para no duplicar customer Shopify existente).
- Updates de campos en contacto con ambas identidades enlazadas se propagan automáticamente en ambas direcciones (LWW por campo — R3).

El asesor de un contacto puede divergir del asesor de sus oportunidades/órdenes — es regla de negocio explícita, no anomalía (R2). Un contacto anonimizado pierde nombre/email/teléfono pero conserva ID y relaciones para preservar histórico.

**Identidades del contacto** (modelado de transición)
En v5 las identidades externas viven directamente como columnas (`shopify_customer_id`, `whaapy_contact_id`) en la entidad Contacto, no como entidad relacional separada. Esto refleja que en MVP cada contacto tiene como máximo 2 identidades (Shopify + Whaapy). Si V2 expande a más canales (Instagram, Facebook Messenger, etc.), se evalúa migrar a entidad relacional `contact_identities` sin retrabajo del core — la decisión de modelado concreta (columnas vs entidad relacional desde día 1) la toma Claude Code en M1.

*Reglas de integridad:* la combinación de organización + `shopify_customer_id` (cuando no es null) es única. Misma regla para `whaapy_contact_id`. El identity matching durante sincronización opera por teléfono E.164 y email normalizado: si encuentra match con un contacto existente, **agrega la identidad faltante al contacto existente** (no crea duplicado). En el caso Shopify → Whaapy faltante, **dispara propagación automática a Whaapy**; en el caso Whaapy → Shopify faltante, **NO dispara propagación automática** — el enlace ocurre cuando el vendedor/admin use el botón "Crear contacto en Shopify" en M6 (asimetría v5.1).

#### 3.3.4 Grupo C — Pipeline (venta + post-venta)

**Etapa del pipeline**
Cada paso por el que pasa una oportunidad dentro de un funnel. Las etapas son por organización y por funnel — Centr y Rustr pueden tener pipelines distintos; cada funnel tiene su propio set de etapas.

*Información relevante:* nombre visible (ej. "Cotización"), funnel al que pertenece (venta o post-venta), posición en el orden del pipeline, color de display, probabilidad default asociada (solo relevante en Funnel Venta), flag de etapa inicial (la que reciben oportunidades nuevas del funnel), flag de etapa ganada, flag de etapa perdida, flag de "requiere motivo al moverse" (típicamente en etapas perdidas).

*Relaciones:* 1..N con oportunidades del funnel correspondiente. Aparece en el histórico de cambios de etapa.

*Reglas de integridad:* cada funnel de cada organización debe tener exactamente UNA etapa marcada como inicial. En Funnel Venta es obligatorio tener al menos una etapa ganada y una perdida. En Funnel Post-venta NO hay etapas terminales obligatorias (el post-venta es continuo). No se puede eliminar una etapa con oportunidades dentro (se debe primero migrar las oportunidades a otra etapa, o desactivar la etapa). La `default_probability` se ignora en etapas del Funnel Post-venta.

**Motivo de pérdida**
Catálogo editable de razones por las que una oportunidad puede perderse. Aplica solo al Funnel Venta y solo cuando una oportunidad se mueve a una etapa con flag de "requiere motivo".

*Información relevante:* nombre visible, descripción opcional (interpretación interna), flag de activación.

*Relaciones:* 0..N con oportunidades perdidas (cada oportunidad perdida referencia un motivo).

*Reglas de integridad:* el admin puede crear, renombrar y desactivar motivos, pero no eliminar uno que esté referenciado por oportunidades. Renombrar un motivo afecta visualmente a las oportunidades pasadas que lo referencian (lo cual es deseable: si "ghosting" se renombra a "Sin respuesta del cliente", el cambio aplica retroactivamente). Desactivar un motivo no afecta oportunidades pasadas; solo lo oculta de futuras selecciones.

**Oportunidad**
Unidad central del CRM. Cada oportunidad pertenece a un funnel (venta o post-venta), vive en una etapa específica, tiene un contacto asociado y un asesor asignado. Las oportunidades de Funnel Venta representan cotizaciones/negociaciones; las de Funnel Post-venta representan el seguimiento del cliente después de la compra.

*Información relevante:* funnel, etapa actual, contacto asociado, asesor asignado (proveniente de tags de Shopify), oportunidad padre (solo en Funnel Post-venta — apunta a la oportunidad de Funnel Venta que le dio origen), referencias a Shopify (Draft Order ID y Order ID, ambos opcionales según el caso), referencia visible al cliente (ej. "#D123"), monto real (proveniente de Shopify cuando hay Draft Order/Order), monto estimado (capturado manualmente por el asesor cuando todavía no hay Draft Order), moneda, probabilidad heredada de la etapa con override opcional manual, monto ponderado (calculado), motivo de pérdida (solo si aplica), URL de invoice de Shopify si existe, nota, dirección de envío si aplica, timestamps del lifecycle (creada, modificada, fecha de invoice enviada si aplica, fecha de ganada si aplica), metadatos de last-write-wins.

*Relaciones:* N..1 con contacto, N..1 con asesor (membresía organizacional), N..1 con etapa, N..1 con motivo de pérdida (cuando aplica), 1..1 opcional con oportunidad padre (solo Funnel Post-venta), 1..N con line items, 1..N con tareas, 1..N con actividades del timeline, 1..N con entradas del histórico de etapa.

*Reglas de integridad clave:*
- Una oportunidad de Funnel Venta debe tener `parent_opportunity_id` nulo.
- Una oportunidad de Funnel Post-venta debe tener `parent_opportunity_id` no nulo, apuntando a una oportunidad de Funnel Venta del mismo contacto y misma organización.
- El motivo de pérdida es obligatorio si y solo si la etapa actual lo requiere.
- El monto ponderado solo aplica a Funnel Venta (no se calcula para Funnel Post-venta).
- Cuando una oportunidad de Funnel Venta pasa a etapa ganada vía webhook `orders/paid`, automáticamente se crea su oportunidad hija en Funnel Post-venta (operación atómica — ver R1 en 3.3.10).
- La oportunidad de Funnel Venta original NO se altera al crear la hija; queda cerrada como ganada para histórico y métricas.
- **Auto-creación POST-backfill en etapa inicial del Funnel Venta — Modelo C2 (v5.1):** dos disparadores generan oportunidad automática en la etapa marcada como `is_initial = true` del Funnel Venta (semánticamente "Lead nuevo" en el catálogo pre-cargado):
  - **(a) Contacto nuevo entra a Whaapy** (primera vez que aparece en la base maestra de la organización — sea por webhook `contact.created` de Whaapy o por match de identidad nueva durante procesamiento).
  - **(b) Contacto existente vuelve a interactuar en Whaapy después de N días sin actividad** (default N=30, configurable por el admin desde Reglas).
  El asesor de la oportunidad recién creada se hereda del `assigned_advisor_id` del contacto (asignación nativa Whaapy). Si el contacto no tiene asesor, la oportunidad queda sin asignar hasta acción del admin. **Durante el backfill de M11 esta auto-creación está suprimida** (flag `backfill_in_progress` activa modo pasivo) — sin esta supresión, cada contacto histórico leído generaría una oportunidad "Lead nuevo" sintética que no refleja la realidad del proceso comercial. Regla operativa completa documentada en R12.
- **Botón manual "Crear oportunidad nueva"** en M6 (detalle de contacto) sigue existiendo para casos especiales: lead capturado fuera de Whaapy, oportunidad adicional sobre contacto activo, corrección de oportunidad eliminada, etc. La auto-creación C2 cubre el caso default; el botón manual cubre las excepciones.

**Line item de oportunidad**
Cada producto cotizado dentro de una oportunidad. Sincronizado desde los `line_items` del Draft Order de Shopify; capturable manualmente si la oportunidad nace en plataforma sin Draft Order todavía.

*Información relevante:* oportunidad, referencia al producto en Shopify (puede ser nulo si es producto custom — Shopify soporta Custom Line Items nativamente), título del producto (siempre presente), SKU si existe, cantidad, variante si aplica, precio unitario original, descuento aplicado a la línea, precio final, peso si está disponible, marca fiscal (taxable o no).

*Relaciones:* N..1 con oportunidad. No tiene relación directa con un catálogo de productos en la plataforma — Centr Hub NO mantiene réplica del catálogo de Shopify; cada line item es snapshot del producto al momento de la cotización.

*Reglas de integridad:* si la oportunidad se sincroniza desde Shopify, los line items se reemplazan en bloque cada vez que cambia el Draft Order. Si la oportunidad se creó manualmente (sin Draft Order todavía), los line items se gestionan manualmente hasta que llegue una Draft Order que los reemplace.

**Histórico de cambios de etapa**
Cada movimiento de una oportunidad entre etapas. Sirve para métricas de Win rate por etapa, sales cycle length, tiempo promedio en etapa y otras analíticas operativas.

*Información relevante:* oportunidad, etapa anterior (puede ser nula en la creación), etapa nueva, usuario que disparó el cambio (puede ser nulo si fue un cambio automático del sistema o vía webhook), timestamp del cambio, contexto del cambio (manual, webhook, automatización, trigger F1→F2).

*Relaciones:* N..1 con oportunidad. Inmutable — los registros nunca se editan ni borran.

*Reglas de integridad:* cada vez que cambia la etapa de una oportunidad se inserta una entrada. La etapa anterior debe coincidir con el último registro de histórico para esa oportunidad (consistencia eventual permitida — los cron jobs reconcilian si hay drift por webhooks fuera de orden).


#### 3.3.5 Grupo D — Órdenes

**Orden**
Una venta cerrada en Shopify (Order). Es la fuente de verdad de revenue real. Una orden se asocia con la oportunidad de Funnel Venta que la generó (cuando esa asociación existe — backfill o creación manual desde Shopify pueden producir órdenes huérfanas, ver reglas abajo).

*Información relevante:* contacto asociado, asesor asignado (proveniente de tags de Shopify de la orden, independiente del asesor del contacto y de la oportunidad), referencia a la oportunidad de Funnel Venta que la originó (puede ser nula en órdenes huérfanas), referencias a Shopify (Order ID, nombre visible "#1234"), estado financiero (pagada, pendiente, reembolsada, etc.), estado de fulfillment (no enviada, parcialmente enviada, enviada, etc.), monto total (revenue real), subtotal, impuestos, costo de envío, descuento aplicado, moneda, timestamps (creación, pago confirmado, cancelación si aplica, última actualización), razón de cancelación si aplica, fuente de origen (web, POS, draft_order, etc.), tags de Shopify conservadas, metadatos de last-write-wins.

*Relaciones:* N..1 con contacto, N..1 con asesor, 0..1 con oportunidad de Funnel Venta originadora, 1..N con line items.

*Reglas de integridad:*
- Una orden con estado financiero "pagada" debe disparar el trigger F1→F2 si tiene oportunidad de Funnel Venta asociada (ver reglas transversales).
- Una orden cancelada NO se borra — se marca con razón de cancelación.
- El asesor de la orden puede diferir del asesor de la oportunidad y del contacto. Las métricas por vendedor del dashboard se calculan según el asesor de la **orden**, no del contacto ni la oportunidad. Justificación documentada en R5 (3.3.10).
- Órdenes huérfanas (sin oportunidad asociada) son válidas — pueden surgir del backfill cuando se sincroniza una orden cuya Draft Order original ya fue auto-borrada por Shopify (Shopify auto-borra Draft Orders después de 1 año de inactividad). En ese caso la orden se crea sin asociación, y los reportes la cuentan para revenue pero no aparece en el pipeline.

**Line item de orden**
Cada producto vendido dentro de una orden. Análogo conceptualmente al line item de oportunidad pero ligado a la orden pagada.

*Información relevante:* idéntico al line item de oportunidad — referencia al producto en Shopify (puede ser nulo), título, SKU, cantidad, variante, precios, descuento, peso, marca fiscal.

*Relaciones:* N..1 con orden.

*Reglas de integridad:* sincronizados desde Shopify; nunca editables manualmente. Sirven para los reportes de "Top productos vendidos".

#### 3.3.6 Grupo E — Motor de automatización

**Regla de automatización**
Una regla del motor. Cada regla pertenece a una organización y a un funnel específico (una regla solo evalúa oportunidades de su funnel). Las reglas se construyen con tres componentes: trigger (cuándo evaluar), condiciones (qué debe cumplir), acciones (qué hacer si pasa).

*Información relevante:* organización, funnel al que aplica, nombre visible, descripción opcional, flag de activación, flag de plantilla (las pre-cargadas vienen como plantillas editables), tipo de trigger (uno de: `stage_aging`, `no_activity`, `created`, `stage_changed`, `won`, `lost`, `contact.created`, `contact.no_activity`), configuración del trigger (estructura libre que parametriza el trigger — ej. "después de cuántas horas en etapa", "qué etapa específica"), lista de condiciones (estructura libre que codifica condiciones como `monto > 5000`, `etapa = "Cotización"`, `asesor in [X, Y]`), lista de acciones (estructura libre que codifica acciones del set permitido: `create_task`, `notify_advisor`, `notify_admin`, `move_to_stage`, `add_tag`), usuario que la creó, timestamps.

**Guardrails al payload JSONB:**
- Validación con Zod obligatoria al recibir input desde la UI (principio de organización del código de 3.2 reiterado aquí por criticidad).
- Cada payload incluye un campo `schema_version`. Si en V2 cambia la estructura, se identifican reglas "v1" vs "v2" sin migración destructiva.

*Relaciones:* N..1 con organización, 1..N con ejecuciones.

*Reglas de integridad:*
- Una regla solo evalúa oportunidades de su funnel.
- Las reglas con triggers de evento (`created`, `stage_changed`, `won`, `lost`, `contact.created`) se evalúan en línea cuando el evento ocurre.
- Las reglas con triggers de tiempo (`stage_aging`, `no_activity`, `contact.no_activity`) se evalúan en jobs periódicos cada hora.
- Circuit breaker: una regla que excede N ejecuciones por hora se desactiva automáticamente con alerta al admin.
- La acción `assign_to_advisor` **no existe** — la plataforma no asigna; la asignación viene de fuentes externas (decisión cerrada Research v6).
- La acción `send_template_message` **no existe en MVP** — depende de templates aprobados en Meta, gestionados por otro equipo. V2 si Centr lo pide.
- La acción `send_freeform_message` **no existe en MVP** — requería sincronización de mensajes Whaapy para validar la ventana 24h de WhatsApp Business; con Whaapy sincronizando solo contactos, no es viable. V2 puede reintroducirla junto con sincronización de mensajes si Centr lo solicita.

**Ejecución de regla**
Cada vez que una regla se evalúa y produce acción (o falla intentándolo), se inserta una entrada de ejecución. Es el log de auditoría del motor.

*Información relevante:* regla, oportunidad o contacto evaluado, timestamp de ejecución, estado (success | failed | skipped — skipped cuando las condiciones no se cumplen), resultado en estructura libre (qué acción se ejecutó concretamente, o por qué falló).

*Relaciones:* N..1 con regla, N..1 opcional con oportunidad o contacto.

*Reglas de integridad:* inmutable — las ejecuciones nunca se editan ni borran (parte del audit trail). Idempotencia: la misma regla evaluando la misma oportunidad en dos ciclos seguidos NO debe producir dos ejecuciones con acción duplicada (mecanismo de "ya ejecutado en este ciclo" que el motor mantiene).

#### 3.3.7 Grupo F — Operativo

**Actividad de oportunidad (timeline)**
Cada evento relevante en la vida de una oportunidad o de un contacto: cambio de etapa, recepción de orden, pago confirmado, tarea creada, nota agregada, regla ejecutada que la afectó, asignación manual del admin, etc. Es el "feed unificado" que se muestra en el detalle.

**NO incluye eventos de mensajes Whaapy** (no se sincronizan — el vendedor ve los mensajes en el iframe de Whaapy). Las identidades Whaapy del contacto sí se reflejan en el detalle del contacto (ver Grupo B), pero el contenido de las conversaciones vive solo en Whaapy.

*Información relevante:* oportunidad (puede ser nulo si la actividad es a nivel contacto), contacto, tipo de actividad (cambio_de_etapa, tarea_creada, tarea_completada, nota, pago_confirmado, orden_creada, regla_ejecutada, asignacion_manual, etc.), descripción breve, payload con detalles específicos en estructura libre, usuario o sistema que la disparó, timestamp.

*Relaciones:* N..1 con contacto, N..1 opcional con oportunidad.

*Reglas de integridad:* inmutable. Las actividades se generan automáticamente por triggers del sistema (webhooks de Shopify, cambios de etapa, ejecución de reglas) o manualmente (notas del vendedor, asignaciones del admin).

**Tarea de oportunidad**
Una acción concreta que un usuario debe hacer respecto a una oportunidad o contacto. Las tareas se crean automáticamente por el motor de reglas (acción `create_task`) o manualmente desde el detalle de oportunidad.

*Información relevante:* organización, oportunidad o contacto al que aplica (al menos uno de los dos), asignada a un usuario, tipo (llamar, responder WhatsApp, cotizar, follow_up — los tipos visualmente representados con icono en Mi Día), título, descripción, fecha de vencimiento, estado (pendiente | completada | snoozeada), snooze hasta (cuando aplique), timestamps (creada, completada).

*Relaciones:* N..1 con organización, N..1 opcional con oportunidad, N..1 opcional con contacto, N..1 con usuario asignado.

*Reglas de integridad:* una tarea debe estar asociada al menos a un contacto u oportunidad. Una tarea snoozeada vuelve a aparecer en Mi Día cuando pasa el timestamp de snooze. Una tarea completada queda registrada en histórico para métricas de "seguimientos completados".

**Notificación**
Pieza individual que aparece en Mi Día del usuario. Generada por el motor de reglas (acciones `notify_advisor` y `notify_admin`), por triggers del sistema (anomalías del parser de tags como múltiples tags-vendedor en misma entidad, vendedor desactivado con mapeo activo), o por eventos puntuales (oportunidad recién creada, anomalía detectada por el sistema).

**Guardrails al payload JSONB:** mismo principio que las reglas — `schema_version` en estructura libre + validación Zod al ingresar input.

*Información relevante:* organización, usuario destinatario, tipo (call, message, quote, follow_up, alert, meeting reservado para V2), origen (regla | manual | sistema), referencia al origen específico cuando aplica (ID de la regla, ID del evento), oportunidad relacionada opcional, contacto relacionado opcional, título visible, mensaje, monto en juego opcional (para sorting en Mi Día), fecha de vencimiento, estado (pendiente | completada | snoozeada | descartada), snooze hasta, fecha de completado.

*Relaciones:* N..1 con usuario, N..1 opcional con oportunidad, N..1 opcional con contacto.

*Reglas de integridad:* una notificación de tipo `alert` (anomalía detectada) **debe** llegar a un usuario con rol admin de la organización. Las notificaciones se entregan al cliente vía Supabase Realtime para aparición instantánea sin reload.

**Audit log**
Registro inmutable de operaciones sensibles: anonimización ARCO ejecutada, mapeo de tag creado/modificado, regla activada/desactivada, usuario invitado/desactivado, etapa creada/modificada/eliminada, anomalía de múltiples tags-vendedor, error de tenant context faltante, ejecución de re-procesamiento de oportunidades tras reclasificación de tag, eventos Whaapy no soportados (`unhandled_whaapy_event`), reportes de bugs internos, atribución histórica del backfill (`historical_attribution_to_active_vendor`, `historical_attribution_to_admin_due_to_former_employee`, `historical_attribution_to_historic_user`). Es la capa de auditoría que cubre tanto cumplimiento (ARCO) como diagnóstico operacional.

*Información relevante:* organización, usuario actor (puede ser nulo si la operación fue del sistema), tipo de evento, entidad afectada (referencia opcional + tipo), payload en estructura libre con detalles, timestamp, IP de origen si aplica.

*Relaciones:* N..1 con organización.

*Reglas de integridad:* inmutable. Conservado indefinidamente — no participa en políticas de retención automática.

#### 3.3.8 Grupo G — Configuración

**Meta**
Objetivo de revenue para un periodo, asignado a un vendedor específico o a la organización global. Solo aplica al Funnel Venta — Funnel Post-venta no tiene metas de revenue.

*Información relevante:* organización, vendedor (nulo significa meta global de la organización), tipo de periodo (mensual | trimestral | anual), inicio y fin del periodo, monto target, count target opcional (cantidad de oportunidades cerradas), usuario que la creó, timestamps.

*Relaciones:* N..1 con organización, N..1 opcional con vendedor.

*Reglas de integridad:* el admin puede crear, editar o eliminar metas en cualquier momento — Centr confirmó que sus metas cambian frecuentemente y necesitan ser fluidas. Una meta eliminada no afecta histórico de cumplimiento ya calculado en periodos cerrados (se conservan los reportes generados). Múltiples metas pueden coexistir para el mismo vendedor en periodos distintos.

**Configuración de la organización**
Bloque de ajustes operativos que el admin gestiona desde la plataforma: umbrales de semáforos (cobertura pipeline verde/amarillo, cumplimiento mensual verde/amarillo, **muestra mínima para Win rate por etapa** — default 10), defaults aplicados a nuevas oportunidades, configuración de identidad fiscal si aplica, otras preferencias agrupadas.

*Información relevante:* organización (1..1), estructura libre con los ajustes. Conceptualmente "extiende" la configuración base de la organización; puede materializarse como tabla aparte o como bloque de configuración en la entidad organización — Claude Code decide en M1 (Observación O3).

*Relaciones:* 1..1 con organización.

*Reglas de integridad:* los umbrales tienen defaults razonables si el admin no los ha configurado (cobertura: 3x verde / 2-3x amarillo / <2x rojo; cumplimiento: 100% verde / 90-99% amarillo / <90% rojo; muestra mínima Win rate: 10). Cualquier valor se puede sobreescribir desde la pantalla de admin.

**Mapeo de tag ↔ vendedor**
Configuración explícita que clasifica una tag de Shopify (normalizada) en una de dos categorías: **"de vendedor"** (mapea a un vendedor específico, dispara atribución automática) o **"informativa"** (se conserva en la oportunidad como metadata sin disparar lógica de asignación). Todas las tags sin clasificar son "informativas por default".

*Información relevante:* organización, tag normalizada (lowercase + trim), tag original (preservada para display tal como llegó la primera vez), clasificación (`vendor | informational`), vendedor asignado (nulo si la tag es informativa, o si la tag de vendedor mapea a un vendedor desactivado), usuario que creó/modificó el mapeo, timestamps.

*Relaciones:* N..1 con organización, N..1 opcional con vendedor (membresía organizacional) — solo cuando clasificación es `vendor`.

*Reglas de integridad:*
- La combinación organización + tag normalizada es única dentro de la organización.
- Toda tag detectada en `shopify_tags` de cualquier entidad de la org existe automáticamente en el catálogo de mapeos con clasificación `informational` por default. El admin puede reclasificarla a `vendor` cuando quiera y mapearla a un vendedor.
- Si el vendedor referenciado se desactiva (membresía con flag de activación en false), el mapeo queda con vendedor nulo — las entidades nuevas con esa tag entran sin asignar y se loguea evento de "tag mapeada a vendedor desactivado".
- Botón "Re-procesar oportunidades con esta tag" (decisión de diseño del Master Document, materializada en M7): cuando el admin reclasifica una tag de `informational` a `vendor` y la mapea, las entidades existentes con esa tag se pueden re-procesar en background para aplicarles la atribución retroactivamente.
- Centr usa muchas tags informativas (`"FACTURADA"`, `"VIP"`, `"+30KG"`, `"PROMOCIÓN"`) que NO son candidatas a vendedor. El modelo binario hace explícita la diferencia y elimina el ruido operativo de detectar tags "huérfanas".


#### 3.3.9 Seeds iniciales

Cada organización se crea con los siguientes datos pre-cargados. Estos seeds son **parte del modelo conceptual del producto** porque definen el comportamiento "out of the box" de Centr Hub — sin ellos, la plataforma estaría vacía y Centr tendría que configurar todo manualmente para empezar a operar.

**Etapas pre-cargadas — Funnel Venta** (9 etapas, editables por admin — modelo refinado en v5.1 con base en el proceso real de Centr en GoHighLevel):

| # | Nombre | Prob. inicial | Tipo |
|---|---|---|---|
| 1 | Lead nuevo | 10% | Inicial (recibe auto-creación por R12 — Modelo C2) |
| 2 | Contactado asesor | 20% | Manual |
| 3 | Contacto calificado | 30% | Manual |
| 4 | Reunión agendada | 45% | Manual |
| 5 | Diseño de espacios | 55% | Manual |
| 6 | Cotización | 70% | Llegada automática desde Shopify Draft Order (webhook `draft_orders/create`) |
| 7 | Seguimiento para cierre | 85% | Manual |
| 8 | Ganada | 100% | Ganada (automática al recibir webhook `orders/paid`) |
| 9 | Perdida | 0% | Perdida, requiere motivo |

Las probabilidades iniciales son razonables y editables por el admin desde la pantalla de Etapas (M7). El nombre de cada etapa, su orden, color y flags también son editables — Centr puede ajustar el pipeline si el proceso comercial evoluciona. Lo único que el admin no puede eliminar es la propiedad estructural de tener al menos una etapa inicial, una ganada y una perdida en el Funnel Venta (3.3.4).

**Etapas pre-cargadas — Funnel Post-venta** (6 etapas, editables por admin):

| # | Nombre | Tipo |
|---|---|---|
| 1 | Pago confirmado | Inicial (creada automáticamente por trigger F1→F2) |
| 2 | Preparación / Envío | Manual |
| 3 | Entregado | Manual |
| 4 | Seguimiento post-entrega | Automática a los 7 días de entregado (por regla) |
| 5 | Cliente activo | Manual |
| 6 | Caso problemático | Manual |

**Motivos de pérdida pre-cargados** (6 motivos, editables por admin):

- Precio
- Tiempo
- Competencia
- Ghosting (sin respuesta del cliente)
- No era buen fit
- Otro

**Reglas pre-cargadas — 4 core activas + 2 opcionales inactivas**

*Activas desde el primer login del admin (resuelven los 3 dolores explícitos de Centr "de fábrica"):*

| # | Funnel | Nombre | Trigger | Condición | Acción |
|---|---|---|---|---|---|
| 1 | Venta | Cotización sin respuesta 24h | `stage_aging` en "Cotización" | 24h en etapa, sin actividad nueva | Tarea automática al asesor: "Hacer seguimiento" |
| 2 | Venta | Oportunidad estancada 72h | `no_activity` | 72h sin actividad, etapa activa (no terminal) | Notificar al asesor + al admin |
| 3 | Venta | Seguimiento para cierre tardío | `stage_aging` en "Seguimiento para cierre" | >7 días en etapa | Notificar al admin |
| 4 | Post-venta | Cliente entregado hace 7 días | `stage_aging` en "Entregado" | 7 días en etapa | Tarea al asesor: "Contactar cliente para seguimiento" + mover a "Seguimiento post-entrega" |

*Opcionales (inactivas — el admin las activa cuando lo decida):*

| # | Funnel | Nombre | Trigger | Condición | Acción |
|---|---|---|---|---|---|
| 5 | Post-venta | Cliente activo sin recompra 90 días | `no_activity` | 90 días sin actividad en oportunidad de Funnel Post-venta en etapa "Cliente activo" | Tarea de re-contacto al asesor |
| 6 | Post-venta | Caso problemático abierto >48h | `stage_aging` en "Caso problemático" | >48h en etapa | Notificar al admin |

**Configuración inicial de umbrales de semáforos:**

- Cobertura pipeline vs meta: verde ≥ 300%, amarillo 200-299%, rojo < 200%.
- Cumplimiento mensual: verde ≥ 100%, amarillo 90-99%, rojo < 90%.
- Muestra mínima para Win rate por etapa: 10 (configurable desde la misma pantalla de Umbrales).

**Usuario sistema "Histórico"** (creado automáticamente como seed de cada organización):

Cada organización (Centr en M1, Rustr cuando se cree, cualquier organización futura) recibe automáticamente un usuario sistema llamado "Histórico" con la siguiente configuración:

| Atributo | Valor |
|---|---|
| Nombre completo | Histórico |
| Email | `historico@<org-slug>.centrhub.local` (placeholder, no recibe correo real) |
| Rol | vendedor |
| `is_system_user` | true |
| Color identificador | gris neutral (distintivo de vendedores reales) |
| Membresía organizacional | desactivada (no puede entrar a la plataforma) |

Su única función es **contenedor de atribución histórica** durante el backfill (M11) para órdenes sin tag legible que se atribuyen a "Histórico" en lugar de quedar huérfanas. Decisión confirmada por Centr en Discovery 2 (respuesta 2.2).

**Decisiones diferidas a la operación (no van en seeds, se configuran cuando Centr empiece a operar):**
- Metas iniciales por vendedor.
- Mapeo de tags ↔ vendedor inicial (depende del setup operativo con Centr).
- Branding final (logo, paleta exacta — Centr lo entrega antes de F7).

#### 3.3.10 Reglas de integridad transversales

Reglas que cruzan múltiples entidades y aplican como invariantes del sistema, no de una entidad individual.

**R1 — Trigger atómico Funnel Venta → Funnel Post-venta.**
Cuando llega webhook `orders/paid` y la oportunidad de Funnel Venta asociada se mueve a etapa con flag de ganada: en una sola operación atómica (todo o nada), (a) se marca la oportunidad de Funnel Venta como ganada con timestamp de ganada, (b) se crea una nueva oportunidad en Funnel Post-venta con etapa inicial del funnel, heredando contacto y asesor de la oportunidad original, (c) se establece el `parent_opportunity_id` de la nueva al ID de la original, (d) se inserta entrada en histórico de etapa de la original. Si cualquier paso falla, todo se revierte y se loguea fallo + alerta al admin.

**Pre-condiciones validadas antes de ejecutar (si fallan, el procesamiento del webhook continúa normalmente y la orden se marca como pagada, pero NO se dispara el trigger):**
- La oportunidad F1 debe existir.
- Debe tener `parent_opportunity_id` nulo (es de Funnel Venta, no Post-venta).
- La etapa destino debe tener `is_won = true`.
- El Funnel Post-venta de la org debe tener una etapa con `is_initial = true` (defensa contra catálogo mal configurado).

**El trigger NO se dispara para movimientos manuales** a etapa ganada. Razón: protección contra error humano + integridad de datos. El trigger F1→F2 se basa en evento atómico de `orders/paid` que es la única señal confiable de "pago real". Las ganadas manuales son operación administrativa (corrección de error de drag, ajuste retroactivo) y no deben encadenar acciones automáticas. Si Centr en operación reporta que quieren disparar trigger también en ganada manual, se evalúa como ajuste de regla.

**R2 — Asignación independiente del asesor.**
Tres entidades pueden tener asesor asignado: contactos, oportunidades, órdenes. Sus asesores pueden coincidir o divergir según las fuentes operativas:
- **Contactos:** heredan asesor de Shopify vía identity matching cuando hay match con customer Shopify que lleva tag de vendedor (Ajuste final 5 — la plataforma NO consume `conversation.assigned` de Whaapy). Sin match Shopify, queda sin asesor hasta asignación manual del admin desde M6.
- **Oportunidades y órdenes:** asesor asignado por el parser de tags de Shopify al crear/actualizar la Draft Order u Order correspondiente.

La plataforma NO ejecuta lógica de reconciliación entre los tres — cada uno mantiene su asignación de origen. El admin puede reasignar manualmente cualquiera de las tres entidades cuando haga falta corregir errores.

**Caso crítico:** la reasignación manual del admin sobre una oportunidad de Funnel Venta YA ganada NO propaga al asesor de la oportunidad hija de Funnel Post-venta. La hija mantiene la asignación heredada en el momento del trigger atómico. Razón: la reasignación admin sobre F1 ganada típicamente es corrección histórica; propagar reescribiría la realidad operativa.

**R3 — Last-write-wins con granularidad diferenciada.**
La granularidad de last-write-wins depende del tipo de entidad:

- **Entidades con una sola fuente externa** (oportunidades desde Shopify Draft Orders, órdenes desde Shopify Orders): LWW a nivel **registro completo**. Cuando llega un cambio, se compara el `updated_at` del payload contra el timestamp del registro local; si el del payload es más reciente, se aplica todo el registro; si no, se descarta y se loguea como "evento fuera de orden ignorado".

- **Datos de contacto** (que existen en Shopify, Whaapy y la base maestra simultáneamente — Ajuste post-Discovery 2 #14): LWW **por campo individual**, no por registro. Comparación de `updated_at` por campo. Cada campo del contacto lleva metadata sobre cuándo se actualizó por última vez y qué fuente lo escribió; el campo gana al timestamp más reciente. Esto permite que un update Whaapy actualice el teléfono y conserve el email enriquecido por Shopify, sin sobrescritura cruzada.

**Borrados intencionales propagados:** si un campo viene vacío en un update reciente, el vacío **SÍ sobrescribe** el valor existente. El usuario pudo haber borrado el dato deliberadamente; preservar el valor antiguo contradice la intención. Aplica a campos editables (nombre, email, teléfono, dirección, notas). NO aplica a identificadores externos (`shopify_customer_id`, `whaapy_contact_id`) — esos solo se borran con la operación explícita de desenlazar identidad.

**Excepción aplicable solo al match inicial (ajustada en v5.1 al flujo asimétrico):** el "match inicial" ocurre en dos situaciones concretas:
- **(a) Shopify → Whaapy automático:** customer nuevo de Shopify dispara creación en Whaapy. En este flujo Shopify es la fuente — sus campos llenan la creación. No hay conflicto con Whaapy porque el contacto se está creando ahí.
- **(b) Whaapy → Shopify manual (botón "Crear contacto en Shopify"):** el vendedor abre el modal, los campos vienen pre-llenados desde el maestro (que ya tiene los campos sincronizados de Whaapy), y el vendedor puede editarlos antes de confirmar. Al confirmar, los campos del modal se envían a Shopify. **No aplica regla automática de "Shopify gana"** — el vendedor es quien decide los valores finales en el modal.
- **(c) Match defensivo durante enlace manual:** si el modal del botón "Crear contacto en Shopify" detecta que el teléfono normalizado ya existe como customer en Shopify, NO se crea duplicado: se enlaza la identidad Shopify existente al maestro. En ese momento, los campos del customer Shopify pre-existente tienen prioridad sobre los del maestro (Shopify es la fuente principal cuando ya existía allá — Discovery 2); pero si un campo está vacío en Shopify y tiene valor en el maestro, se preserva el valor del maestro (no se borra). Después del enlace, LWW por campo universal con borrados propagados.

**Implementación:** Claude Code decide en M1/M3/M4 si materializar esto como columnas adicionales de metadata por campo, como entidad relacional de "field history", o con una capa de servicio que reconcilia explícitamente en cada upsert de contacto. El principio operativo es el mismo: ningún campo se sobrescribe con un valor más viejo que el actual, salvo borrado intencional reciente.

**R4 — Idempotencia obligatoria en sincronización.**
Todo webhook entrante debe deduplicar por su ID único (`X-Shopify-Event-Id` o equivalente de Whaapy). Procesar dos veces el mismo evento debe producir exactamente el mismo estado final que procesarlo una vez. Esto aplica al handler de entrada y al worker async.

**R5 — Métricas de revenue solo de órdenes totalmente pagadas.**
El revenue real para dashboard y reportes proviene del monto total (`total_amount`) de órdenes con `financial_status = 'paid'` (totalmente pagada) con timestamp `paid_at` en el periodo, NO del monto estimado capturado en oportunidades. Estados parciales como `partially_paid` o `partially_refunded` NO cuentan como revenue. El monto estimado se muestra solo en la vista de la oportunidad individual y NUNCA se cuenta como revenue. El pipeline ponderado proviene del monto (real o estimado, en ese orden de preferencia) multiplicado por la probabilidad de la etapa.

**Asesor de orden como fuente de revenue por vendedor:** las métricas por vendedor del dashboard se calculan según el `assigned_advisor_id` de la **orden**, no del contacto ni de la oportunidad. Justificación: el asesor que cierra la venta es quien la cierra según las tags al momento del cobro. Esto cubre el caso edge donde un vendedor crea la Draft Order, se va de Centr, otro lo reemplaza y se etiqueta en la Order final: el revenue cuenta para el segundo. Comportamiento operativamente correcto.

Si Centr en uso real reporta preferencia distinta (revenue al asesor de la oportunidad F1, o al asesor del contacto), es ajuste de query sin retrabajo de schema.

**R6 — Aislamiento de tenant defensivo.**
Toda query a datos de tenant debe pasar por contexto de tenant explícito (ver Sección 3.7). Una query sin contexto de tenant lanza error inmediato — no se permite acceso multi-tenant accidental ni silencioso.

**R7 — (Reservado).** La regla original sobre validación de ventana 24h de WhatsApp se eliminó al simplificar Whaapy para sincronizar solo contactos (sin mensajes ni acción `send_freeform_message`). El número se mantiene reservado para futuras reglas transversales sin renumerar las posteriores.

**R8 — Conservación de histórico por borrados externos.**
Borrar un customer en Shopify o un contact en Whaapy NO borra el contacto en la plataforma; lo marca como "borrado en sistema X" y conserva sus oportunidades, órdenes y timeline para histórico y métricas.

**R9 — Anonimización ARCO preserva la integridad relacional.**
Al ejecutar anonimización de un contacto, se borran/sobrescriben los campos identificables (nombre, email, teléfono, dirección, nota) pero se conservan el ID, las identidades externas (Shopify customer ID, Whaapy contact ID son referencias técnicas opacas que no permiten reidentificar sin acceso al sistema externo), y todas las relaciones. Las oportunidades, órdenes y métricas asociadas al contacto siguen visibles bajo "Cliente anonimizado #{id}".

**Justificación del alcance de ARCO:** la preservación de identidades externas NO viola ARCO porque son referencias técnicas opacas. El cumplimiento ARCO local se logra anonimizando los campos identificables que viven en BD de Centr Hub. Shopify y Whaapy tienen sus propios procesos ARCO si el cliente solicita borrado en esos sistemas.

**R10 — Usuario sistema "Histórico" tiene restricciones especiales de operación.**
El usuario sistema "Histórico" (Sección 3.3.9) opera bajo reglas distintas que los vendedores reales:

- **NO puede ser asignado manualmente desde la UI** — no aparece en dropdowns de "Asignar vendedor" en M6 (detalle de contacto/oportunidad) ni en M7 (mapeo de tags ↔ vendedor) ni en M11 (pantalla Usuarios) ni en ningún otro selector de vendedor.
- **NO es elegible para reasignaciones manuales del admin.** Si el admin necesita "limpiar" datos asignados a "Histórico" (caso operativo: identificar manualmente a quién pertenecían retroactivamente), debe usar la operación de "Reasignar asesor" sobre la oportunidad/orden específica, eligiendo un vendedor real activo.
- **NO recibe asignaciones automáticas del parser de tags** — el parser solo asigna a vendedores reales con membresía activa.
- **Su única vía de asignación es el backfill de M11**, vía las reglas explícitas: orden con tag NO legible → "Histórico"; orden con tag identificable de ex-vendedor sin membresía activa → admin de la org (no "Histórico").
- **NO es eliminable, NO es reactivable, NO es invitable** desde la pantalla Usuarios de M11 — solo se muestra en modo lectura con indicador visual "(usuario sistema)".
- **NO computa en KPIs de desempeño por vendedor** del Dashboard de M10 (cobertura, cumplimiento, win rate por asesor). Sí aparece como filtro opcional separado "Ver atribución histórica" para auditoría admin (ver M10).

**R11 — Bucles de sincronización deben prevenirse con detección de origen en webhooks entrantes.**
La sincronización bidireccional de contactos (Ajuste post-Discovery 2 #14) introduce el riesgo técnico más importante de la arquitectura: ciclos infinitos. La plataforma edita un contacto → propaga a Shopify Y Whaapy vía APIs salientes. Shopify recibe el update y dispara webhook `customers/update` de vuelta. Whaapy hace lo mismo (`contact.updated` de vuelta). Si la plataforma procesa esos webhooks sin detectar que vienen de su propio cambio, entra en bucle infinito — los webhooks entrantes y salientes generan loop con cuotas de API consumidas en minutos.

**Defensa requerida — M3 y M4 implementan detección de origen antes de procesar updates de sus respectivos sistemas, desde el primer commit.** Las dos opciones razonables son:

- **(a) Marcar las llamadas salientes con un identificador** (header custom, nota interna, propiedad/metafield custom) que indique "este cambio viene de la plataforma". Al recibir el webhook resultante, descartarlo si lleva ese marcador.
- **(b) Comparar `updated_at` del webhook contra `last_modified_at` del maestro.** Si son iguales o el webhook es más viejo que la última escritura local (porque fue causado por la propia plataforma justo antes), descartar.

**La decisión técnica concreta (cuál de las dos opciones) la toma Claude Code en M3 y M4** según lo que las APIs de Shopify y Whaapy permitan. Pero **la regla operativa es no negociable: M3 y M4 deben implementar defensa contra bucles desde el primer commit**. Esta defensa no se difiere a iteración tardía — sin ella, el primer edit del primer contacto rompe el sistema en producción.

Eventos descartados por defensa de bucle se loguean como audit log `sync_loop_prevented` (para diagnóstico operacional sin contaminar el flujo normal). El audit log permite al operador verificar que la defensa está operando si sospecha que la sincronización no propaga.

**R12 — Auto-creación de oportunidades en "Lead nuevo" — Modelo C2 (v5.1).**
La pestaña Pipeline (M5) refleja el trabajo activo de los vendedores. Para que un contacto que está conversando con Centr en WhatsApp aparezca naturalmente como oportunidad en el pipeline sin requerir creación manual cada vez, la plataforma auto-crea oportunidades de Funnel Venta en la etapa marcada como `is_initial = true` (semánticamente "Lead nuevo") en dos disparadores:

- **(a) Contacto nuevo entra a Whaapy.** Cuando un contacto aparece por primera vez en la base maestra desde Whaapy (sea por webhook `contact.created` o por match de identidad nueva durante procesamiento de webhook), se crea automáticamente oportunidad nueva en etapa inicial del Funnel Venta. Asesor: heredado del `assigned_advisor_id` del contacto (si Whaapy entregó asignación nativa o ya tenía asesor). Si el contacto no tiene asesor, la oportunidad queda sin asignar.

- **(b) Contacto existente vuelve a interactuar en Whaapy después de N días sin actividad.** Si el `last_whaapy_activity_at` del contacto fue hace más de N días (default N=30) y llega evento de actividad reciente en Whaapy (mensaje nuevo, conversación re-abierta, evento equivalente según docs de Whaapy), se crea oportunidad nueva en etapa inicial. Razón operativa: un cliente o lead silencioso que vuelve a hablar es señal de interés renovado que merece tracking activo en el pipeline. N es configurable por organización desde la pantalla Reglas (default 30).

**Pre-condiciones (todas deben cumplirse para que la auto-creación dispare):**
- El Funnel Venta de la organización debe tener una etapa con `is_initial = true` (defensa contra catálogo mal configurado).
- El contacto NO debe tener ya una oportunidad activa (no terminal — no ganada ni perdida) en Funnel Venta. Si ya hay oportunidad activa, no se crea duplicado — la auto-creación es para abrir tracking nuevo, no para multiplicar oportunidades sobre el mismo flujo comercial vivo.
- El flag `backfill_in_progress` de la organización debe estar en false. Durante el backfill de M11 esta auto-creación se suprime — el backfill no genera oportunidades sintéticas.

**Modo del botón manual "Crear oportunidad nueva":** sigue existiendo en M6 (detalle de contacto) para los casos donde la auto-creación no aplica:
- Lead capturado por canal distinto a Whaapy (referido, evento presencial, etc.) que no genera webhook Whaapy.
- Oportunidad adicional sobre un contacto que ya tiene oportunidad activa (caso B2C raro pero válido — segundo producto, segundo pedido independiente).
- Corrección de oportunidad eliminada por error.

**Materialización delegada a Claude Code:** la implementación concreta (regla del motor con nuevo tipo de acción `create_opportunity`, servicio dedicado escuchando eventos de M4, worker Inngest con scheduler, etc.) la decide Claude Code al construir M8 o M4 según convenga. El principio operativo es el mismo: los dos disparadores generan oportunidad en etapa inicial sin intervención del usuario, salvo las pre-condiciones listadas.

**Audit log obligatorio:** cada auto-creación deja entrada en audit log con tipo `c2_opportunity_auto_created` indicando el disparador (`new_contact_in_whaapy` o `reactivity_after_n_days`), el contacto, la oportunidad creada y el `assigned_advisor_id` heredado. Permite al operador y al admin diagnosticar por qué apareció una oportunidad si no fue manual.

#### 3.3.11 Observaciones y decisiones de modelado

Notas que afectan la traducción de este modelo conceptual a schema SQL en M1.

**O1 — Rol como valor fijo, no entidad.**
El Research v6 (sección 11.1) define 3 roles fijos en MVP: superadmin, admin, vendedor. No hay configurabilidad de permisos por rol en MVP (eso es V2 — y existe ya un patrón validado en Kibah: tabla `roles` con `permissions JSONB` + hook `usePermissions`, Apéndice B.2 del Playbook v6). En MVP, el rol vive como valor fijo en la membresía, no como entidad. Migrar a entidad en V2 es retrocompatible: una migración agrega la tabla `roles`, migra los valores existentes a registros, y la columna `role` pasa a ser FK al ID de roles. Sin pérdida de datos.

**O2 — Loss reasons como entidad de catálogo, no enum.**
El Research v6 sección 5.4 originalmente menciona `loss_reason_category ENUM`. Esto se modifica en este Master Document a entidad de catálogo (`Motivo de pérdida`) por dos razones: (a) el Research v6 también dice "editables por el admin" en sección 5.3.1, lo cual es incompatible con un enum de PostgreSQL (modificar enums requiere migración); (b) usar entidad permite renombrar sin perder histórico y soft-delete sin perder datos. Es una decisión de modelado tomada en este Master Document que diverge ligeramente del Research v6 para preservar la capacidad de edición que el mismo Research v6 requiere.

**O3 — Configuración de organización: tabla aparte o bloque dentro de organizations.**
Lo dejo a discreción de Claude Code en M1. El criterio práctico: si los ajustes que necesita Configuración de Organización son pocos y estables (3-5 campos), pueden vivir como bloque de configuración estructurada dentro de la entidad organización. Si crecen o se vuelven dinámicos, entidad aparte. La Sección 3.7 ya documenta que `organizations` lleva un bloque de configuración y un bloque de branding — son los candidatos naturales para esta consolidación.

**O4 — Modelo binario de tags: de vendedor vs informativa.**
Centr usa tags en Shopify para muchas cosas, no solo para identificar vendedores. Tags como `"FACTURADA"`, `"VIP"`, `"+30KG"`, `"PROMOCIÓN"` son informativas. Solo las tags que el admin deliberadamente marca como "de vendedor" entran al sistema de atribución; las demás se reflejan en `shopify_tags` de la entidad como información, sin disparar lógica.

Concretamente, una tag en `Mapeo de tag ↔ vendedor` está en uno de dos estados:
- (a) **De vendedor** (`vendor`): mapea a un vendedor específico, atribución activa. Si el vendedor luego se desactiva, mapeo queda con vendedor nulo y se loguea.
- (b) **Informativa** (`informational`): conservada en `shopify_tags` para display, sin producir atribución, sin generar alertas. Default para toda tag detectada que el admin no haya reclasificado.

**Decisión de modelado:** sin estado "huérfana" o "pendiente" — la mayoría de las tags NO son tags de vendedor, eso es comportamiento normal. Eliminar la noción de "huérfana" elimina ruido operativo (notificaciones espurias) y simplifica el mental model del admin.

**O5 — Oportunidades pre-Shopify.**
Es válido que una oportunidad de Funnel Venta exista en la plataforma SIN Draft Order todavía: el vendedor capta un lead manualmente o por auto-creación C2 (R12), abre la oportunidad o la encuentra auto-creada, le pone `estimated_amount`, la mueve por las etapas intermedias del Funnel Venta ("Lead nuevo" → "Contactado asesor" → "Contacto calificado" → "Reunión agendada" → "Diseño de espacios"). Solo cuando crea la Draft Order en Shopify llega el webhook `draft_orders/create` y la oportunidad se enriquece con `shopify_draft_order_id` + line items reales + monto real + transición a etapa "Cotización". El modelo debe soportar oportunidades con `shopify_draft_order_id` nulo durante esta fase pre-cotización.

**O6 — Órdenes huérfanas.**
Es válido que llegue una orden de Shopify sin oportunidad de Funnel Venta asociada — típicamente del backfill cuando la Draft Order original ya fue auto-borrada por Shopify, o de órdenes hechas directo en Shopify sin pasar por flujo de cotización. La orden se crea con `opportunity_id = nulo` y se cuenta en métricas de revenue. NO se crea oportunidad sintética para llenarle el hueco — sería información inventada.

**O7 — Futureproofing de Reuniones (V2).**
Centr **descartó explícitamente** el módulo de Reuniones del MVP (Research v6 changelog v5→v6). Queda como posible V2 si Centr lo pide explícitamente. El dominio "oportunidad" es el lugar natural donde colgaría la relación cuando se materialice: en V2 se crearía una entidad `meetings` y una referencia opcional desde la oportunidad y/o contacto. En M1, no se crea la entidad ni la columna — solo se documenta que el modelo de la oportunidad puede absorber la relación sin retrabajo.

**O8 — Futureproofing de B2B / Companies (V2).**
Análogo a O7. Si Centr en V2 arranca línea B2B, se crea entidad `Empresa`, se agrega referencia opcional desde `Contacto`. No se reserva nada en MVP — agregar es no destructivo.

**O9 — Branding por organización como sub-bloque, no entidad aparte.**
El Research v6 sección 11.6 define multi-org branding con logo + colores por tenant (cada org con identidad propia, mismo estilo general). Para MVP (2 tenants Centr + Rustr) un bloque de configuración estructurada dentro de la entidad organización es suficiente. Si V2 escala a multi-tenant comercial con branding más complejo (assets dinámicos, fonts custom, hojas de estilo overrides), se evalúa migrar a entidad aparte sin retrabajo del core.

**O10 — Usuario sistema "Histórico" como contenedor de datos pre-Centr-Hub.**
Confirmado por Centr en Discovery 2 (respuesta 2.2). Cada organización lleva un usuario sistema llamado "Histórico" creado automáticamente como seed inicial (Sección 3.3.9). Es contenedor de atribución para órdenes del backfill (M11) que NO tienen tag legible identificable. Distinto a "asignación a admin" — el admin recibe atribución cuando la orden tenía tag identificable de un ex-vendedor (vendedor que ya no está en la empresa); "Histórico" recibe atribución cuando NO había tag legible o cuando la tag no es interpretable.

**Decisión de modelado:** marcar con flag `is_system_user = true` (o equivalente que Claude Code decida en M1 — columna en `users` o entidad relacional). Esto permite:
- Distinguir programáticamente en queries (excluir de KPIs de desempeño, filtrar en dropdowns de asignación).
- UI consistente: la pantalla Usuarios (M11) lo muestra con indicador visual especial.
- Migración futura no destructiva: si V2 quiere agregar más usuarios sistema (ej. "Bot IA", "Sin asignar"), el patrón ya está.

NO se permite eliminar, ni reactivar, ni invitar el usuario sistema "Histórico" desde la UI. Solo lectura.

**O11 — Base maestra de contactos como fuente única de verdad. Shopify y Whaapy son espejos sincronizados (con asimetría en creación, v5.1).**
Confirmado por el operador en repaso final pre-M0 (mayo 2026) y refinado en la revisión post-M2 (21 de mayo 2026) tras revisar el flujo real de Centr en GoHighLevel. La entidad Contacto en la BD de la plataforma es la **fuente única de verdad** para datos de contactos. Shopify y Whaapy son sistemas externos espejados.

**Justificación operativa:** hoy Centr edita el mismo dato manualmente en tres sistemas (Shopify para venta, Whaapy para mensajería, Excel para reportes). Es dolor operativo central — produce divergencia, errores, y tiempo perdido. Centr Hub resuelve esto al ser la base maestra: el vendedor edita en cualquiera de los tres (Shopify, Whaapy, plataforma) y la sincronización se propaga transparentemente a los otros dos.

**Modelo de sincronización asimétrico en creación, simétrico en updates (refinamiento v5.1):**
- **Shopify → Whaapy:** creación automática. Un customer nuevo en Shopify que no tiene contraparte Whaapy dispara creación en Whaapy vía API saliente (si `missing_phone = false`).
- **Whaapy → Shopify:** creación manual on-demand. Un contacto nacido en Whaapy queda como **lead** en la plataforma sin propagación automática a Shopify. El vendedor/admin lo convierte a cliente Shopify explícitamente desde el botón "Crear contacto en Shopify" en M6 (detalle de oportunidad o contacto), con modal de campos editables y match defensivo por teléfono normalizado para no duplicar customer existente.
- **Updates de campos en contacto con ambas identidades enlazadas:** propagación automática bidireccional (LWW por campo — R3).

**Razón operativa de la asimetría:** la mayoría de contactos que entran a Whaapy sin contraparte Shopify son **leads no calificados** (preguntas iniciales, consultas que no avanzan, prospectos que no compran). Crear cada uno automáticamente en Shopify satura el customer base con registros que distorsionan reportes de Shopify y consumen cuotas de API innecesariamente. La asimetría refleja la lógica comercial: un lead se vuelve cliente cuando el vendedor decide trabajarlo seriamente, no automáticamente.

**Clasificación lead vs cliente derivada (v5.1):** la presencia/ausencia de `shopify_customer_id` clasifica automáticamente al contacto como lead (sin Shopify) o cliente (con Shopify). Es propiedad derivada, no campo manual. La pestaña Contactos consume esta clasificación para badge visual y filtros. Cuando el botón "Crear contacto en Shopify" enlaza identidad Shopify, el contacto pasa automáticamente de lead a cliente sin acción adicional.

**Decisión de modelado:** identificadores externos (`shopify_customer_id`, `whaapy_contact_id`) viven como columnas en la entidad Contacto, no como entidad relacional separada — refleja el caso MVP de máximo 2 identidades por contacto. Si V2 expande a más canales, se migra a entidad relacional `contact_identities` sin retrabajo del core.

**Decisión arquitectónica:** la mecánica de sincronización vive distribuida entre M3 (Shopify inbound + outbound), M4 (Whaapy inbound + outbound + auto-creación C2 de oportunidades), M6 (edición manual con propagación + botón "Crear contacto en Shopify"). CLAUDE.md sección "Sincronización bidireccional de contactos" documenta el flujo de propagación y las reglas anti-bucle (R11) + auto-creación (R12) — es lectura obligatoria al construir M3, M4, M6.

**Reversión parcial del Ajuste final 5:** la decisión de "Whaapy sincroniza solo contactos sin api_key server-side" del Ajuste final 5 se mantiene parcialmente — Whaapy sigue sincronizando solo contactos (no mensajes, no media), pero **ahora se necesita api_key server-side para llamadas salientes** (crear/actualizar/asignar contactos en Whaapy via API). El iframe sigue usando sesión nativa del navegador para que el vendedor opere conversaciones. Las dos cosas coexisten: iframe para chat operacional + API saliente para sincronización de contactos.

**O12 — Clasificación lead vs cliente como propiedad derivada, no campo manual (v5.1).**
La distinción lead/cliente no es un estado editable del contacto. Es propiedad **derivada en runtime** de la presencia de `shopify_customer_id`: si está enlazado, es cliente; si no, es lead. Esta decisión evita la divergencia que ocurriría si fuera flag manual editable (un cliente Shopify mal marcado como lead seguiría siendo cliente en realidad).

**Decisión de modelado delegada a Claude Code en M1:** materializar la derivación como columna calculada en Postgres (`type` = CASE WHEN shopify_customer_id IS NOT NULL THEN 'cliente' ELSE 'lead' END), vista derivada (`contact_with_type`), o derivación en la capa de servicio in-app — cualquiera de las tres es válida. El principio operativo se conserva: no hay flag editable que pueda divergir de la realidad de identidades enlazadas.

**Uso en UI (M6):** la pestaña Contactos muestra badge "Lead" (color secundario) o "Cliente" (color primario) según la derivación. Los filtros (solo-leads / solo-clientes / todos) operan sobre esa propiedad. La transición lead → cliente ocurre automáticamente cuando se enlaza identidad Shopify (vía sincronización automática Shopify → maestro, o vía botón "Crear contacto en Shopify" que enlaza el nuevo `shopify_customer_id`).

---

### 3.4 API endpoints

Los endpoints específicos de cada milestone se documentan en sus respectivos prompts del archivo de milestones (`CENTR-MILESTONES-v5.md`, Sección 11). Este documento de doctrina deja documentado el patrón general que todos los endpoints respetan:

- **Validación con Zod obligatoria** en cada route handler que reciba input externo (incluidos webhooks).
- **Auth check vía middleware** en rutas autenticadas (descritas en 3.5). Rutas públicas explícitas: `/login`, `/auth/callback`, `/privacidad`, `/api/webhooks/shopify/*`, `/api/webhooks/whaapy/*`, `/api/inngest` (endpoint del SDK de Inngest — verificación de firma, no de sesión).
- **Server actions o route handlers** según naturaleza. Webhooks son route handlers (necesitan acceder a body raw para verificación HMAC antes de parsing). Operaciones de mutación desde UI prefieren server actions para tipado end-to-end.
- **Respuestas tipadas con Zod** en endpoints que retornen JSON.
- **Endpoints de exportación de reportes** se construyen en M10 con generación server-side de archivos (Excel/PDF) y respuesta como stream descargable.
- **Endpoints administrativos protegidos** para operaciones sensibles (ej. ejecución del backfill en M11) detrás de un middleware que verifica rol superadmin/admin.

Detalle de cada endpoint vive en el prompt del milestone correspondiente (`CENTR-MILESTONES-v5.md`).

### 3.5 Auth flow

#### Modelo de identidad

La identidad y autenticación de usuarios se delegan a **Supabase Auth**. La plataforma extiende ese sistema con metadata propia (rol, organización, vendedor) vía la entidad de membresía descrita en 3.3.2. El JWT emitido por Supabase Auth lleva claims custom que la app y RLS consumen: identificador del usuario, organización activa, rol dentro de esa organización.

**Tres roles fijos en MVP:**
- **Superadmin** (VADAI) — acceso multi-organización. Selector de tenant visible siempre que pertenezca a más de una.
- **Admin** (Centr/Rustr) — acceso completo dentro de su organización. Configura catálogos, reglas, metas, mapeo de tags, invita usuarios, ejecuta ARCO.
- **Vendedor** — acceso restringido a sus propias entidades (contactos, oportunidades y órdenes asignadas vía `assigned_advisor_id`), su propio Mi Día, su propio dashboard.

#### Flujos de auth soportados

**Login con Email + Password (default):**
Vendedor o admin ingresa credenciales en la pantalla de login. Si son válidas, se establece sesión y se redirige al dashboard de la organización a la que pertenece. Si pertenece a más de una organización, primero se muestra selector de organización; al elegir, se establece la organización activa y se redirige.

**Magic Link como fallback ("Olvidé mi contraseña"):**
Desde la pantalla de login, el usuario hace click en "Olvidé mi contraseña" o "Iniciar sesión sin contraseña", ingresa su email, recibe un link en su correo, lo abre, y queda autenticado. Esto cubre dos casos sin pantalla adicional: recuperación de cuenta y login alternativo. Supabase Auth lo gestiona nativamente.

**Sin Google OAuth en MVP.** Se evalúa para V2 si Centr lo solicita.

#### Onboarding de usuarios nuevos

El flujo administrativo completo se materializa en M11 (la pantalla de "Usuarios" del admin). Hasta entonces, los usuarios se cargan vía SQL directo en Supabase como deuda controlada. El flujo final post-M11 es:

1. Admin entra a la pantalla de Usuarios.
2. Admin presiona "Invitar vendedor".
3. Llena el formulario: nombre completo, email, color identificador, rol (admin o vendedor), opcionalmente el `whaapy_agent_id` si ya está mapeado del lado de Whaapy.
4. Al confirmar, la plataforma usa Supabase Auth para enviar email de invitación al destinatario.
5. El destinatario recibe email con link de activación. Hace click, define su contraseña, queda autenticado y entra a la plataforma con su rol asignado dentro de la organización del admin.

#### Sesión y contexto de tenant

Toda sesión autenticada lleva en su JWT la organización activa. El middleware del servidor establece el contexto de tenant (segunda barrera defensiva descrita en 3.7) antes de que cualquier query se ejecute.

**Cambio de organización (solo aplica si el usuario pertenece a >1):**
El selector de organización vive en el navbar. Al cambiar, se actualiza la claim del JWT (re-emisión via refresh) y se recarga el contexto de la app. Todas las queries posteriores operan en la nueva organización.

**Cierre de sesión:**
Logout estándar de Supabase Auth — invalida la sesión, limpia cookies, redirige al login.

#### Seguridad transversal del auth

- La `service_role_key` de Supabase nunca llega al navegador. Solo se usa en server-side (route handlers, server actions, workers de Inngest).
- Credenciales de proveedores externos viven cifradas en Supabase Vault, descifradas solo dentro del worker que las necesita: **Shopify (`client_id`, `client_secret`, `access_token` derivado vía client_credentials grant y cacheado)** para lectura/escritura de customers, draft orders, orders y verificación HMAC de webhooks (signing key = Client Secret); y **Whaapy api_key** para llamadas salientes (crear/actualizar/asignar contactos vía API — necesario por la sincronización del Ajuste post-Discovery 2 #14 + revisión v5.1). El iframe de la pestaña Whaapy usa la sesión nativa del navegador del usuario para operación conversacional — eso no requiere token server-side. La api_key server-side cubre exclusivamente las APIs salientes que orquestan sincronización de contactos.
- Las rutas autenticadas están protegidas por middleware que valida sesión antes de ejecutar lógica. Acceso sin sesión a una ruta autenticada redirige a login.
- Las acciones sensibles del admin (ARCO, desactivar usuario, modificar mapeos de tags) dejan huella en el audit log (3.3.7).


### 3.6 Integraciones externas — vista general

Detalle por proveedor:

#### Shopify

- **API:** Admin GraphQL `2026-04`. **App creada en Shopify Dev Dashboard (`partners.shopify.com`) e instalada por organización vía OAuth.** Modelo Custom App del Dev Dashboard, no Custom App clásica del Admin (Shopify retiró el flujo de Custom Apps clásicas el 1 de enero de 2026 — toda integración post 1-ene-2026 pasa por el Dev Dashboard).
- **Flujo de credenciales (post 1-ene-2026):**
  - Shopify entrega un par **Client ID + Client Secret** de la app en el Dev Dashboard.
  - El `access_token` por tienda se obtiene en runtime vía **client_credentials grant** (intercambio servidor a servidor contra Shopify), cacheado en Vault con refresh cuando expire.
  - **Webhook signing secret = Client Secret.** En el flujo nuevo, Shopify firma los webhooks con el mismo Client Secret — no hay un valor separado. HMAC-SHA256 de webhooks se verifica contra Client Secret con comparación constant-time.
  - **Tres valores viven en Vault por organización:** `client_id`, `client_secret`, y `access_token` derivado (cacheado). El SOP de rotación 90 días (Sección 10.x / CLAUDE.md) aplica al Client Secret; el `access_token` rota por contrato del grant, no manualmente.
- **Scopes operativos al instalar la app (Custom Apps del Dev Dashboard tienen acceso automático):**
  - `read_customers`, `write_customers` — pertenecen a Protected Customer Data Levels 1 y 2. **Acceso automático al instalar la app por la organización; no hay Protected Customer Data Form que llenar** (eso aplica solo a apps publicadas en el Shopify App Store).
  - `read_all_orders` — **se aprueba en la instalación, no requiere request manual en Partner Dashboard** (mismo modelo). Esencial para el backfill de M11 — sin este scope, Shopify limita las queries a últimos 60 días.
  - Otros scopes técnicos para draft_orders, orders, etc., otorgados en la instalación.
  - Modelo confirmado por instalación real en mayo 2026 + lección en `ERRORES.md` ("Protected Customer Data malinterpretado").
- **Llamadas salientes (outbound — Ajuste post-Discovery 2 #14, refinadas en v5.1 con asimetría en creación):** la plataforma invoca Shopify Admin API para propagar cambios de contacto a Shopify. Endpoints típicos:
  - `POST /admin/api/.../customers.json` (**crear customer en Shopify — disparado exclusivamente desde el botón manual "Crear contacto en Shopify" en M6**, no automáticamente desde webhooks de Whaapy). El modal permite al vendedor/admin editar los campos antes de enviar. Match defensivo previo: si el teléfono normalizado ya existe como customer Shopify, NO se crea duplicado — solo se enlaza la identidad faltante al maestro y se notifica al vendedor.
  - `PUT /admin/api/.../customers/{id}.json` (actualizar customer con cambios provenientes de Whaapy o de M6, **solo si el contacto ya tiene `shopify_customer_id` enlazado**). Updates de contacto sin identidad Shopify enlazada no propagan a Shopify hasta que se enlace identidad.
  - Agregar/quitar tags de vendedor también vía este endpoint (propagación de asignación de asesor desde Whaapy o desde M6 admin), **condicional a que el contacto ya tenga `shopify_customer_id` enlazado**.

  **Las credenciales de Shopify en Vault cubren estas llamadas — sin nuevo secret**. El cliente outbound obtiene `access_token` vía client_credentials grant antes de la primera llamada (o lo toma del cache en Vault si está vigente). Nota operativa importante: Shopify soporta nativamente customers con `orders_count = 0` (la plataforma puede crear un customer en Shopify aunque el contacto no haya hecho compra todavía — útil cuando el vendedor convierte un lead a cliente desde M6). **La asimetría v5.1 implica que la creación automática Whaapy → Shopify del modelo original ya no ocurre** — es manual on-demand.
- **Verificación HMAC de webhooks:** HMAC-SHA256 con **Client Secret como signing key** (no hay secret separado de webhooks en el flujo del Dev Dashboard) + comparación constant-time antes de parsear JSON.
- **Dedup:** clave en Upstash Redis con namespace dedicado a Shopify, usando `X-Shopify-Event-Id` y TTL de 24h.
- **Defensa anti-bucle (R11):** las llamadas salientes a Shopify se marcan con identificador de origen "plataforma" (header, nota, propiedad custom — Claude Code decide en M3 según lo que la API permita). Webhooks `customers/update` entrantes que lleven ese marcador se descartan + audit log `sync_loop_prevented`.
- **Procesamiento:** la app encola en Inngest con el payload + metadatos del tenant; workers async procesan después y aplican last-write-wins. La respuesta 200 a Shopify se envía en menos de 5 segundos.
- **Credenciales en Vault (post 1-ene-2026):** tres valores cifrados por organización — `client_id`, `client_secret`, `access_token` derivado (cacheado con refresh). NO en `.env`. Cubre tanto lecturas (Bulk Operations, reconciliaciones, refresh del access_token) como las llamadas salientes del Ajuste #14. **Rotación 90 días aplica al Client Secret** (regenerable desde Dev Dashboard); el `access_token` rota por contrato del client_credentials grant, no manualmente.
- **Backfill inicial:** ejecutado en M11 vía Bulk Operations (no consume rate limits significativos). **El alcance es TODO el histórico desde apertura de la tienda Shopify de Centr** (Ajuste post-Discovery 2 #8 — respuesta 2.0 del cliente). NO es rango parametrizable. Scope `read_all_orders` operativo al instalar la app (Custom App del Dev Dashboard tiene acceso automático — sin este scope, Shopify limita a últimos 60 días). Expectativa operativa: el backfill puede tardar varias horas según volumen real — Bulk Operations procesa async del lado de Shopify, el operador lanza, espera callback de "completado", y procesa el archivo de resultados por chunks vía Inngest. Si en el futuro otras organizaciones (ej. Rustr) eligen rango menor, ahí sí se parametriza por organización. **La sincronización con propagación bidireccional (R11) y la auto-creación C2 (R12) NO aplican durante el backfill** — el backfill solo crea/enriquece el maestro desde Shopify, no propaga cambios de vuelta a Shopify ni a Whaapy ni genera oportunidades sintéticas. La propagación bidireccional y la auto-creación empiezan después del backfill, con webhooks en línea.

#### Whaapy

- **API:** propia, según contrato vigente.
- **Webhooks consumidos (inbound):** `contact.created`, `contact.updated`, `contact.deleted`. **Adicionalmente, M4 consume el webhook que Whaapy provea para "asesor asignado a contacto"** — sea `conversation.assigned`, sea `contact.updated` con campo de asesor cambiado, sea otro evento equivalente; la sesión de M4 decide cuál según docs de Whaapy actuales. La regla operativa es: la plataforma debe enterarse cuando Whaapy asigna asesor a un contacto, para propagar a Shopify (tag mapeada). NO se consumen `message.received`, `message.sent` — los mensajes viven en Whaapy y el vendedor los opera desde el iframe.
- **Llamadas salientes (outbound — Ajuste post-Discovery 2 #14, conserva creación automática en v5.1):** la plataforma invoca la API saliente de Whaapy para propagar cambios de contacto originados en Shopify o en M6 (edición manual). Operaciones típicas:
  - **Crear contacto en Whaapy automáticamente** cuando viene un customer nuevo de Shopify que no existe allá (asimétrico v5.1 — esta dirección sigue siendo automática, a diferencia de Whaapy → Shopify que ahora es manual). Requiere `missing_phone = false`.
  - Actualizar contacto con cambios provenientes de Shopify o de M6 (cuando el contacto tiene `whaapy_contact_id` enlazado).
  - Asignar contacto a `whaapy_agent_id` cuando el asesor cambia desde otra fuente.

  **Whaapy api_key necesario server-side para estas llamadas** — vuelve a Vault (revierte parcialmente el Ajuste final 5; ver bloque Vault abajo). Endpoints concretos a decisión de Claude Code en M4 según docs de Whaapy actuales. Whaapy requiere mínimo nombre y teléfono al crear contacto; la plataforma envía todos los campos disponibles del maestro (email, dirección, notas) para que Whaapy quede sincronizado con la maestra.

- **Auto-creación de oportunidades C2 (v5.1 — disparado desde M4, no es llamada saliente sino acción local):** cuando llega webhook `contact.created` de Whaapy (contacto nuevo en maestro) o cuando un contacto existente con `last_whaapy_activity_at` > N días registra actividad nueva (mensaje, conversación re-abierta), M4 dispara auto-creación de oportunidad en etapa inicial del Funnel Venta con asesor heredado del contacto. Regla operativa completa en R12. Durante backfill esta auto-creación se suprime (flag `backfill_in_progress`).
- **Verificación e idempotencia:** mismo patrón conceptual que Shopify, adaptado al contrato específico de Whaapy. Dedup con namespace distinto en Upstash para separar de Shopify. Eventos no soportados se loguean como `unhandled_whaapy_event` en audit log; notificación al admin SOLO si el mismo evento desconocido aparece >5 veces en 24h.
- **Iframe en plataforma:** la pestaña Whaapy renderiza el chat de Whaapy embebido (técnica validada en Kibah). El vendedor opera todas las conversaciones desde ahí; la plataforma no necesita acceso a los mensajes vía API — para mensajes, el iframe es suficiente y usa la sesión nativa del navegador del usuario.
- **Defensa anti-bucle (R11):** las llamadas salientes a Whaapy se marcan con identificador de origen "plataforma" (la mecánica concreta — propiedad custom, header, comparación de timestamps — la decide Claude Code en M4 según lo que la API de Whaapy permita). Webhooks `contact.updated` entrantes que reflejen un cambio propio se descartan + audit log `sync_loop_prevented`.
- **Identity matching:** webhook de contacto entrante → normalizar phone a E.164 + email a lowercase + trim → buscar contact local existente por estas identidades → si match, **enlazar la identidad Whaapy al contact existente** (puede ya tener identidad Shopify, queda con ambas); si no, crear contact nuevo con identidad Whaapy únicamente. **NO dispara creación automática en Shopify** (asimetría v5.1) — el contacto queda como lead hasta que el vendedor/admin use el botón "Crear contacto en Shopify" en M6.
- **Sin descarga de media.** No se descargan ni almacenan audios, imágenes ni videos de las conversaciones. Quedan en Whaapy.
- **Asignación de asesor:** dos casos.
  - Contacto Whaapy con match Shopify: hereda `assigned_advisor_id` del contact Shopify si lo tiene; si Whaapy entrega su propia asignación nativa después, gana la más reciente por R3 (LWW por campo).
  - Contacto Whaapy nuevo (sin match Shopify — lead): si Whaapy entrega asignación nativa, se aplica al maestro. **NO se propaga a Shopify automáticamente** (no hay customer Shopify a quien aplicarle la tag — el contacto es lead). Si después el vendedor convierte el lead a cliente usando el botón "Crear contacto en Shopify" en M6, la creación en Shopify aplica la tag mapeada del vendedor al customer recién creado. Si Whaapy no entrega asignación nativa, queda sin asesor hasta asignación manual del admin desde M6.

#### Inngest

- Workers, crons y funciones de procesamiento >10s del proyecto. **Vercel free no soporta crons ni funciones largas en su tier — todo lo async pesado vive en Inngest.** Lista de jobs vive en su propio archivo de configuración del repo; concepto:
  - Webhooks de Shopify y Whaapy se encolan acá para procesamiento async.
  - Cron cada hora evalúa reglas de tiempo (`stage_aging`, `no_activity`, `contact.no_activity`).
  - Cron cada hora reactiva tareas/notificaciones snoozeadas que cumplieron su `snoozed_until`.
  - Trabajos puntuales (re-procesamiento masivo de oportunidades con una tag al cambiar su clasificación, generación de PDF visual pesado del dashboard, **llamadas salientes a Shopify y Whaapy de la sincronización bidireccional** — encoladas para retry con backoff si fallan).

#### Supabase

- **Postgres:** schema operativo + RLS habilitado en todas las tablas con `organization_id`.
- **Auth:** Email/Password + Magic Link. Email templates en español.
- **Storage:** bucket de branding (logos por org). **NO se usan buckets de media de Whaapy** — la media vive en Whaapy y se ve desde el iframe.
- **Realtime:** suscripciones filtradas del lado del servidor por organización + scope contextual (funnel activo en pipeline, user_id en Mi Día).
- **Vault:** **Shopify (`client_id`, `client_secret`, `access_token` derivado) y Whaapy api_key**, todas cifradas por organización. Cuatro entradas por org: las tres de Shopify (Client ID + Client Secret + access_token cacheado vía client_credentials grant) post 1-ene-2026 + Whaapy api_key (Ajuste post-Discovery 2 #14 — revierte parcialmente el Ajuste final 5; Whaapy api_key vuelve al Vault ahora que se usa para llamadas salientes desde código, no solo iframe). El iframe sigue usando sesión nativa del navegador para operación conversacional — la api_key server-side cubre exclusivamente APIs salientes de sincronización.
- **Edge Functions:** **NO se usan en MVP.** Toda la lógica server-side vive en route handlers Next.js + workers de Inngest. Edge Functions queda como opción si en V2 se necesita lógica geográficamente distribuida o un endpoint específico no compatible con Vercel.

#### Upstash Redis

- Dedup atómico de webhooks con `SET NX EX` (clave única por evento, TTL 24h).
- Cache puntual donde Claude Code lo considere necesario para no saturar Postgres.

### 3.7 Multi-tenant defensivo

#### Decisión arquitectónica

Multi-tenant **desde día 1**, no como retrabajo. Razones:
- Centr y Rustr ya existen como tenants planeados — no es un escenario hipotético.
- Lección Hemenesy documentada en Playbook v6 F4: refactorizar un schema single-tenant a multi-tenant tarda 5-7 días de retrabajo. Construir multi-tenant desde el inicio agrega ~1 día al schema y libera al equipo de la deuda técnica.
- Permite agregar tenants futuros sin tocar el core.

#### Defensa en profundidad — dos barreras independientes

**Barrera 1 — RLS (Row Level Security) en Postgres.**
Toda tabla con datos de tenant (todas las del modelo operativo) lleva `organization_id`. Las políticas RLS filtran cada query basándose en la organización activa de la sesión, leída desde el JWT del usuario autenticado vía claim custom. Una query mal construida que no incluya filtro de tenant explícito es bloqueada por RLS antes de retornar datos cruzados.

**Barrera 2 — Contexto de tenant en la aplicación.**
Toda operación de datos del lado del servidor pasa por un wrapper que establece el contexto del tenant (resolviendo desde la sesión cuando se origina en una request del usuario, o desde el payload del worker cuando es procesamiento async como webhooks). Operar sin contexto explícito en una operación que requiere tenant lanza error inmediato. Esto cubre los casos donde RLS no aplica nativamente: workers de Inngest que usan service role, scripts administrativos, edge cases.

#### Patrones operativos

- **Resolución de tenant en webhooks:** el endpoint público lee identificador del proveedor externo (`X-Shopify-Shop-Domain` en Shopify, identificador de business en Whaapy) y resuelve a organización antes de encolar. Si no resuelve, se loguea y se responde 200 al proveedor para que no reintente eternamente algo que no se puede procesar; alerta interna al equipo.
- **Wrapper de workers:** todo worker recibe el contexto de tenant explícitamente en su payload (no lo infiere). Operaciones que omiten el wrapper fallan con error claro de "tenant context required".
- **Service role solo server-side:** los workers usan `service_role_key` que bypassea RLS — la única protección efectiva es el wrapper de contexto. La key nunca se importa desde código de cliente.
- **Tests de aislamiento:** parte de la suite de tests valida que datos de la organización A no son accesibles con sesión de organización B, ni en queries normales ni en workers.

#### Lo que se valida durante hardening (M11)

- RLS habilitado y con políticas correctas en cada tabla con `organization_id`.
- No hay queries que bypassen RLS sin justificación documentada.
- Service role key no se filtra al navegador (verificación en bundle output).
- Tokens externos viven en Supabase Vault, no en código ni `.env`.
- Tests de aislamiento pasan con datos sintéticos de dos organizaciones.

---

## Sección 4 — UX Flows

Esta sección documenta los flujos de usuario críticos. Los detalles visuales (espaciado, tipografía exacta, microcopy final, animaciones) se afinan en F7 sobre los componentes construidos durante M2-M10.

### 4.1 Onboarding del vendedor (primer login)

1. El admin del tenant invita al vendedor desde la pantalla de Usuarios (Admin > Usuarios, construida en M11).
2. Supabase Auth envía email de invitación con link de activación (template en español configurado en M2).
3. El vendedor abre el link, define contraseña, queda autenticado.
4. Como pertenece a una sola organización, entra directamente al layout autenticado (sin selector de organización).
5. Llega a la pantalla de Mi Día por default. Si no tiene pendientes (caso del primer día), ve empty state amigable.

### 4.2 Flujo de venta operativo (caso happy path)

**Nota inicial sobre sincronización de contactos** (Ajuste post-Discovery 2 #14 — Observación O11, refinada en v5.1 con asimetría en creación): a lo largo del flujo descrito abajo, las ediciones de campos de contactos en cualquiera de los tres sistemas (Shopify, Whaapy, plataforma) se sincronizan automáticamente con los otros dos cuando el contacto tiene las identidades enlazadas. La **creación** es asimétrica: Shopify → Whaapy automática, Whaapy → Shopify manual on-demand vía botón "Crear contacto en Shopify" en M6. La clasificación lead/cliente del contacto es derivada de la presencia de `shopify_customer_id`. M3 y M4 orquestan la propagación con defensa contra bucles (R11). M4 también dispara auto-creación de oportunidades en "Lead nuevo" según R12 (Modelo C2).

1. **Captura del lead.** Vendedor habla con prospecto por WhatsApp (desde la pestaña Whaapy con iframe de Whaapy). Si Centr usa Whaapy para inbound, el contacto ya existe sincronizado por M4 como **lead** en la base maestra (sin `shopify_customer_id` aún). M4 dispara auto-creación de oportunidad en etapa "Lead nuevo" del Funnel Venta (R12 — Modelo C2), heredando el asesor del contacto si Whaapy lo asignó.
2. **Calificación.** El vendedor ve la oportunidad recién creada en su pipeline (M5) o en Mi Día (M9). Si decide trabajarla, abre el detalle (M6), captura `estimated_amount` y mueve manualmente entre las etapas intermedias del Funnel Venta ("Contactado asesor" → "Contacto calificado" → "Reunión agendada" → "Diseño de espacios") según el avance comercial real.
3. **Conversión lead → cliente Shopify.** Cuando el vendedor está listo para cotizar formalmente, abre el detalle del contacto u oportunidad y presiona "Crear contacto en Shopify". Modal con campos editables aparece; al confirmar, la plataforma invoca API saliente de Shopify para crear customer (con match defensivo por teléfono). El contacto pasa de **lead** a **cliente** automáticamente (la derivación se actualiza al enlazar `shopify_customer_id`).
4. **Cotización.** Vendedor crea Draft Order en Shopify Admin con sus line items para ese customer, **agrega su tag de atribución al crear el Draft Order** (supuesto operativo confirmado por inferencia — Discovery 2 respuesta 1.3 no fue explícita; el operador asume que es la primera acción del flujo donde el vendedor ya sabe que es su cliente), envía el invoice link desde Shopify al contacto por WhatsApp.
5. **Sincronización automática del Draft Order.** Webhook `draft_orders/create` llega a Centr Hub (M3), parser de tags lee la tag y asigna el vendedor. La oportunidad de la plataforma se enriquece con `shopify_draft_order_id`, line items reales y monto real, y pasa automáticamente a etapa "Cotización" del Funnel Venta (el evento de creación de Draft Order es la señal natural de que la cotización fue enviada).
6. **Seguimiento automático.** Si después de 24h no hay actividad nueva en la oportunidad, regla pre-cargada "Cotización sin respuesta 24h" genera tarea automática "Hacer seguimiento" al asesor (M8). El vendedor la ve en Mi Día (M9).
7. **Negociación final.** El vendedor avanza la oportunidad manualmente a "Seguimiento para cierre" cuando el cliente está cerca de pagar.
8. **Pago confirmado.** El cliente paga el invoice link. Shopify cambia el estado de la orden a `paid` y dispara webhook `orders/paid` (M3). El worker mueve la oportunidad de Funnel Venta a etapa "Ganada", y atómicamente crea la oportunidad hija en Funnel Post-venta con etapa "Pago confirmado", heredando contacto y asesor (M7). Toast: "Oportunidad ganada. Se creó seguimiento en Post-venta."
9. **Mantenimiento Post-venta.** La oportunidad en Funnel Post-venta avanza por sus etapas según seguimiento operativo (Preparación → Entregado → Seguimiento post-entrega automático a los 7 días por regla pre-cargada → Cliente activo).
10. **Recompra o re-actividad.** Si el cliente vuelve a comprar, llega nuevo Draft Order/Order y se crea una oportunidad nueva en Funnel Venta. Adicionalmente, si el cliente vuelve a interactuar en Whaapy después de 30 días de silencio (configurable), R12 dispara auto-creación de oportunidad nueva en "Lead nuevo" para reabrir el tracking comercial. Las métricas del dashboard reflejan ambos casos.

**¿Por qué el trigger F1→F2 solo dispara desde webhook `orders/paid` y no desde movimiento manual?**

Si el vendedor mueve manualmente a "Ganada" sin que llegue el pago real, la plataforma no tiene certeza de la transacción comercial. Disparar el trigger F1→F2 en ese caso crearía oportunidades de Post-venta sintéticas sin pago real, contaminando las métricas del dashboard de Funnel Post-venta y desconectando la vista de la realidad operativa de Centr.

Centr puede mover manualmente como corrección administrativa (alguien pagó por fuera de Shopify y el vendedor refleja la realidad), pero ese caso es minoritario y operacional, no debe encadenar acciones automáticas. Si Centr en uso reporta que es caso frecuente y quieren disparar el trigger también en ganada manual, se evalúa como ajuste de regla.

### 4.3 Flujo de pérdida con motivo

Cuando el vendedor mueve una oportunidad a una etapa con flag `requires_loss_reason` (típicamente "Perdida"):

1. Aparece modal de captura: "Selecciona el motivo de pérdida" (microcopy ilustrativo — F7 afina).
2. Dropdown con motivos del catálogo de la organización (pre-cargados + custom del admin).
3. Campo opcional de nota libre.
4. Botón "Confirmar pérdida" + botón "Cancelar".
5. Si confirma: la oportunidad queda en etapa "Perdida" con motivo registrado. Audit log + actividad en timeline.
6. Si cancela: la card vuelve a la etapa anterior, ningún cambio persistido.

Casos especiales:
- Si el admin no ha configurado motivos personalizados, los 6 motivos pre-cargados (3.3.9) son los que aparecen en el dropdown.
- Si todos los motivos se han desactivado (caso raro), el dropdown muestra un único valor "Otro" + nota libre obligatoria. Tooltip simple "El admin no ha configurado motivos personalizados".

### 4.4 Flujo de ARCO (Anonimización ejecutada por admin)

1. Admin entra al detalle de un contacto desde la pestaña Contactos (M6).
2. Presiona botón "Anonimizar contacto (ARCO)" — solo visible para rol admin (M11).
3. Modal de confirmación: "Esta acción es irreversible. Se borrarán nombre, email y teléfono del contacto. El histórico de oportunidades y órdenes se conservará bajo 'Cliente anonimizado #{id}'. ¿Continuar?"
4. Si confirma:
   - El registro del contacto se actualiza atómicamente: nombre → "Cliente anonimizado #{id}", email → null, teléfono → null, dirección → null, nota → null, `anonymized_at` registrado, `anonymized_by` registrado.
   - Identidades externas (Shopify customer ID, Whaapy contact ID) se conservan — son referencias técnicas opacas que NO permiten reidentificar al individuo sin acceso al sistema externo, y borrarlas rompería la sincronización futura.
   - Las oportunidades, órdenes y demás relaciones se conservan tal cual.
   - Se inserta entrada en audit log con tipo `arco_anonymization_executed`: actor (admin), contacto afectado, timestamp.
5. La pantalla del detalle se actualiza mostrando el contacto anonimizado.

### 4.5 Flujo de creación de regla custom por admin (wizard de 3 pasos)

1. Admin entra a Admin > Reglas de automación (construida en M8).
2. Presiona "Nueva regla".
3. **Paso 1 — Trigger:** dropdown del tipo de trigger (`stage_aging`, `no_activity`, `created`, `stage_changed`, `won`, `lost`, `contact.created`, `contact.no_activity`) + parametrización contextual (ej. para `stage_aging`: cuántas horas, qué etapa). Funnel se selecciona aquí.
4. **Paso 2 — Condiciones:** opcional, agregar cero o más condiciones. Cada una con campo + operador + valor. Ejemplos: "monto > 5000", "etapa = Cotización", "asesor en [Gina, Laura]". Combinables.
5. **Paso 3 — Acciones:** una o más acciones del set permitido (`create_task`, `notify_advisor`, `notify_admin`, `move_to_stage`, `add_tag`). Cada una con parametrización contextual.
6. Antes de guardar, vista previa: "Esta regla afectará oportunidades del Funnel X. Última ejecución hipotética con datos actuales: N oportunidades cumplirían las condiciones."
7. Si el wizard detecta contradicciones entre condiciones (ej. "etapa = X AND etapa = Y" con X≠Y) muestra modal de confirmación: "Detectamos que estas condiciones se contradicen — la regla nunca se activará con datos actuales. ¿Estás seguro de continuar?" — fuerza confirmación explícita sin bloquear.
8. Al confirmar, regla queda activa.


---

## Sección 5 — Identidad visual

> Esta sección queda **deliberadamente con placeholders** porque Centr aún no ha entregado paleta cromática exacta, tipografía corporativa ni logos finales (light + dark + monocromático). F7 (la sesión de diseño post-M10) toma estas decisiones con los assets reales en mano.

### 5.1 Inputs visuales de Centr — pendientes de Centr antes de F7

- Logo final en variantes: full (light + dark), monocromático, símbolo aislado, formatos SVG + PNG.
- Paleta cromática primaria y secundaria con valores hex.
- Tipografía corporativa, si Centr tiene una definida (en su defecto se elige por F7 una sin-serif legible).
- Lineamientos de comunicación visual interna de Centr si existen (manual de marca, ejemplos de aplicaciones previas).

### 5.2 Estilo de referencia que F7 toma como ancla

Antes de tener los assets finales, F7 trabaja con un estilo de referencia definido por Claude y el operador. Las referencias documentadas como ancla:

- **Linear** — densidad de información, jerarquía visual, navegación fluida entre pestañas.
- **Sunsama** — vista de Mi Día priorizada por urgencia, gamification ligera (racha, indicadores visuales sin caer en exceso).
- **Notion** — empty states amigables, microcopy claro y conciso, sensación de "espacio para trabajar" sin saturación.
- **Stripe Dashboard** — KPIs y gráficas con semáforos legibles, presentación de números, exportaciones limpias.

Centr Hub NO copia ninguna de estas referencias; toma elementos puntuales y los aplica al contexto B2C de distribuidor mexicano.

### 5.3 Decisiones tomadas en este Master Document (no F7)

- **Dark mode obligatorio.** Toggle desde el navbar. Persistencia de preferencia por usuario.
- **Lenguaje:** español 100% en toda la UI (Centr opera en México). Excepción: términos técnicos universalmente reconocidos pueden conservarse en inglés cuando aplique (Pipeline, Dashboard).
- **Tipografía recomendada de arranque:** Inter como sans-serif por su legibilidad y disponibilidad en CDN. F7 puede cambiarla si Centr tiene tipografía corporativa específica.
- **Tono de microcopy:** informal, directo, sin ser frío. Ejemplos preliminares (todos ilustrativos — F7 afina): "Sin pendientes ahora. Buen trabajo.", "Oportunidad ganada. Se creó seguimiento en Post-venta.", "El admin no ha configurado motivos personalizados."
- **Branding multi-organización:** cada org puede subir su logo + colores propios. Aplica funcionalmente en M11; F7 deja afinado cómo se ve la transición entre orgs cuando el superadmin cambia el tenant activo.

### 5.4 Componentes con ajustes específicos detectados durante construcción

Los detalles visuales acumulados durante M2-M10 viven en `UX-FIXES.md` (Sección 10 de este documento). F7 procesa ese archivo como input principal.

---

## Sección 7 — Roadmap post-MVP

> **Sección 6 (Contenido de landing page) no aplica para Centr Hub** — es una plataforma 100% interna sin landing pública, sin pricing público, sin signup público. Sigue la numeración del Playbook para mantener consistencia, pero queda omitida.

### Items priorizados para V2 (probable en 6-12 meses post-launch si Centr lo solicita)

**V2.1 — Módulo de Reuniones (Google Calendar/Outlook)**
Centr lo descartó del MVP pero ya señaló interés. Materializa la entidad `meetings` documentada en O7. Sincronización bidireccional con Google Calendar y Outlook. Disparadores adicionales al motor de reglas (`meeting.scheduled`, `meeting.completed`, `meeting.no_show`).

**V2.2 — Templates de WhatsApp aprobados**
Cuando el equipo que gestiona Whaapy + Meta tenga templates aprobados, agregar acción `send_template_message` al motor de reglas. Permite mandar mensajes fuera de la ventana 24h legalmente.

**V2.3 — Migración histórica de GHL**
Si Centr cambia de opinión y quiere traer histórico de GoHighLevel (decisión cerrada en Discovery 1: "arrancar limpio"), script único de migración. Mapeo de campos GHL → Centr Hub.

**V2.4 — Vista nativa de conversaciones de Whaapy (alternativa al iframe)**
El iframe de Whaapy es la solución válida para MVP. Si Centr en uso reporta limitaciones (responsive móvil pobre, permisos no granulares), V2 construye vista nativa consumiendo la API de Whaapy directamente.

**V2.5 — Marketing tracking / atribución de origen del lead**
Hoy Centr lo maneja manualmente. V2 agrega entidad de fuentes de origen + tracking de UTM en las páginas de Shopify + atribución first-touch / last-touch.

**V2.6 — App nativa móvil (PWA)**
Responsive web de MVP cumple para uso operativo. V2 habilita PWA en Next.js (es feature nativa del framework) para experiencia móvil instalable.

**V2.7 — Configurabilidad de permisos por rol**
Patrón validado en Kibah (Apéndice B.2 del Playbook v6): tabla `roles` con `permissions JSONB`. Permite roles custom además de los 3 fijos del MVP. Migración retrocompatible (O1).

**V2.8 — UI dedicada para Dead Letter Queue de Inngest**
MVP deja la DLQ funcional con notificación al admin cuando una función falla más allá del threshold de retries (M3). V2 construye pantalla admin para ver eventos fallidos, reintentar manualmente, descartar — gestión avanzada.

**V2.9 — Brechas GHL/Excel detectadas en operación post-launch (reactivo, no comprometido)**
Si en operación real los vendedores o admin reportan que falta funcionalidad específica que tenían en GHL o en sus Excels históricos y que Centr Hub no cubre, esos casos puntuales entran a V2 con scope dedicado en su momento. Categorías candidatas: visualizaciones específicas que Gina hacía manualmente en Excel, atajos operativos de GHL que vendedores extrañen, cálculos custom de comisiones más sofisticados. Sin pre-engineering — se aborda solo si se reporta.

### Items para V3 o más allá (no comprometidos)

- Sub-organizaciones / equipos dentro de un tenant.
- B2B / Companies como entidad separada.
- Multi-canal (Instagram DM, Facebook Messenger).
- Pagos en línea con Stripe (facturación interna).
- Notificaciones por email/SMS además de in-app.
- Reposicionamiento de Centr Hub como SaaS comercial multi-cliente (la arquitectura técnica ya lo soporta).
- Integración con ERP de Centr cuando lo tengan.
- Predicción de cierre por oportunidad usando ML sobre histórico real (después de 6-12 meses de operación con datos suficientes).

### Decisiones que NO entran en roadmap

- Marketing automation completo (Centr usa otras herramientas — no es valor diferencial).
- Email marketing (idem).
- Forecasting financiero avanzado (Centr lo hace en Excel ejecutivo aparte).
- Integración con redes sociales como canal de contenido (fuera de scope total).

---


## Sección 10 — Anexos: archivos vivos del proyecto

Los tres archivos `CLAUDE.md`, `ERRORES.md` y `UX-FIXES.md` se inicializaron en M0 y viven en la raíz del repo. **Esta doctrina ya NO duplica su contenido** — los archivos del repo son la única fuente. Cualquier evolución durante el proyecto se hace ahí, no en este Master Document. Sección 10.4 conserva ejemplos ilustrativos del formato esperado en ERRORES.md y UX-FIXES.md como referencia para Claude Code.

### 10.1 — CLAUDE.md (vive en `CLAUDE.md` raíz del repo)

**Pointer al archivo vivo. NO se duplica contenido aquí (eliminado en v5.1).**

Archivo operativo del proyecto. **Léelo al inicio de cada sesión de Claude Code.** Contiene: stack y versiones (con referencia a Sección 3.1), setup post-M2 del flujo nuevo de Shopify (Dev Dashboard + client_credentials grant + scopes Whaapy elegidos, referencia operativa al modelo documentado en Sección 3.6), skills aplicables y cuándo invocarlas, procedimiento de apertura de sesión de milestone, principios de organización del código (resumen de 3.2), patrones operativos críticos (multi-tenant, webhooks, LWW, sincronización asimétrica de contactos, auto-creación C2, botón "Crear contacto en Shopify", clasificación lead/cliente derivada, pipeline 9 etapas), procedimiento de testing local con webhooks (ngrok/cloudflared), timezone (luxon + America/Mexico_City + crons cada hora), reglas de cambios al stack, convenciones del proyecto (idioma, commits, tests), SOPs operativos (rotación de secretos, backups, monitoreo), supuestos operativos del flujo de venta, alcance del backfill, capacitación del admin para distinguir tags, sincronización de contactos detallada con defensa anti-bucle (R11) + auto-creación C2 (R12), deuda técnica aceptada (warnings de Supabase Security Advisor), instrucciones operativas para Claude Code cuando trabaja en un milestone.

**Mantenimiento:** este archivo evoluciona con el proyecto. Cuando un milestone descubre patrón nuevo, regla operativa nueva, decisión arquitectónica que aplica a milestones futuros, etc., se actualiza ahí. **La doctrina (este Master Document) NO duplica su contenido** — eliminado en v5.1.

**Sincronización con la doctrina:** cuando la doctrina cambia (ej. v5.0 → v5.1), CLAUDE.md se sincroniza en sesión dedicada para que ambos reflejen el modelo vigente. Ver bloque "Cambios respecto a v5.0" en el prólogo del Master Document para los cambios estructurales que CLAUDE.md ya incorpora.

<!-- BEGIN: contenido archivado del CLAUDE.md inicial M0 (pre-v5.1). REMOVIDO en v5.1 para eliminar duplicación. Si necesitas el contenido inicial, consulta el git history del archivo `CLAUDE.md` del repo. -->
<!-- END archived block -->


### 10.2 — ERRORES.md (vive en `ERRORES.md` raíz del repo)

**Pointer al archivo vivo. NO se duplica contenido aquí (eliminado en v5.1).**

Archivo de bugs conocidos, workarounds y lecciones acumulados durante M0-M11. **Léelo al inicio de cada sesión de Claude Code en milestones posteriores a M0** para evitar repetir errores ya documentados. Cada entrada documenta UN bug con: título, milestone donde se detectó, síntoma observado, causa raíz, workaround/fix aplicado, lección general aplicable a milestones futuros.

**Mantenimiento:** cualquier bug nuevo o workaround que apliques durante un milestone se agrega aquí antes del commit final del milestone (regla operativa en CLAUDE.md, sección "Para Claude Code: cuando estás trabajando en un milestone").

**Formato de entrada esperado:** ver Sección 10.4 abajo (referencia ilustrativa).

### 10.3 — UX-FIXES.md (vive en `UX-FIXES.md` raíz del repo)

**Pointer al archivo vivo. NO se duplica contenido aquí (eliminado en v5.1).**

Archivo de ajustes visuales detectados durante M2-M10 que F7 (sesión dedicada de diseño post-M10) procesa como input principal. Cada entrada documenta UN ajuste con: componente o pantalla, issue detectado, sub-sesión de F7 sugerida (A públicas/login | B layout/dashboard | C componentes funcionales | D admin/configuración), severidad (alta | media | baja).

**Mantenimiento:** cualquier ajuste visual pendiente detectado durante implementación se agrega aquí para que F7 lo procese.

**Formato de entrada esperado:** ver Sección 10.4 abajo (referencia ilustrativa).

### 10.4 — Formato y ejemplos ilustrativos

> Esta sección vive en el Master Document, NO en los archivos del repo. Los archivos del repo (`ERRORES.md` y `UX-FIXES.md`) arrancan limpios; estos ejemplos son referencia para que Claude Code y el operador sepan cómo se ve una entrada bien documentada.

**Ejemplo ilustrativo de entrada en ERRORES.md:**

```
### Cookies en App Router son async

- **Milestone:** M2
- **Síntoma:** middleware de auth se ejecutaba sin sesión válida en algunos requests; `cookies()` retornaba objeto vacío.
- **Causa raíz:** en Next.js 14 App Router, `cookies()` retorna Promise; usarla sin `await` da objeto sin métodos útiles.
- **Workaround / fix:** usar siempre `const cookieStore = await cookies();` y pasar el `cookieStore` a `createServerClient` de `@supabase/ssr`.
- **Lección:** todas las helpers de Next.js App Router que tocan request context (`cookies()`, `headers()`) son async desde Next 14. En cualquier handler/middleware nuevo, verificar firma async antes de usar.
```

**Ejemplo ilustrativo de entrada en UX-FIXES.md:**

```
### Spacing entre cards del pipeline kanban es inconsistente en mobile

- **Componente:** Pipeline kanban — vista mobile.
- **Issue:** las cards tienen márgenes que se ven bien en desktop (16px) pero en mobile con scroll horizontal de columnas resultan apretadas; falta padding horizontal en la columna.
- **Sub-sesión sugerida:** C (componentes funcionales).
- **Severidad:** media.
```

---


