# CENTR-DOCTRINE-v5.md

**Versión:** 5.0
**Fecha:** 13 de mayo, 2026
**Cliente:** Centr (distribuidor oficial CENTR x HYROX México) + futura Rustr
**Stack base:** Next.js 14.2.x + Supabase + Vercel free + Tailwind + shadcn/ui
**Nombre tentativo de la plataforma:** Centr Hub
**Decisión arquitectónica clave:** multi-tenant desde día 1
**Documentos de origen:** `CENTR-RESEARCH-V6.md`, `CENTR-SHOPIFY-API-REFERENCE.md`, `VADAI-Playbook-v6.md`, respuestas Discovery 2 del cliente (mayo 2026), `AUDIT-REPORT.md` (auditoría crítica de v3, mayo 2026), repaso final del operador pre-M0 (mayo 2026)

> **Propósito de este archivo:** contiene las Secciones 1 a 10 del Master Document v5 — la doctrina permanente del proyecto (visión, alcance, arquitectura, modelo de datos, integraciones, UX flows, identidad visual, roadmap, anexos vivos). Se adjunta al proyecto en Antigravity como contexto permanente durante toda la ejecución (M0 a M11).
>
> **Los prompts modulares (M0-M11, Sección 11) viven en archivo separado:** `CENTR-MILESTONES-v5.md`. El operador copia el prompt específico cuando inicia cada milestone — el archivo de milestones NO se adjunta al proyecto.
>
> **Cambios respecto a v4:** 3 ajustes finales pre-M0 aplicados — (1) **Ajuste post-Discovery 2 #14: sincronización bidireccional de contactos**, cambio estructural significativo que reformula el modelo de contactos (base maestra como fuente única de verdad, Shopify y Whaapy como espejos sincronizados), agrega R11 + O11, revierte parcialmente el Ajuste final 5 (Whaapy api_key vuelve a Vault porque ahora se usa para llamadas salientes), reescribe partes sustanciales de M3 y M4, modifica M6 y M11; (2) Ajuste de auditoría #8 segunda iteración (trigger de notificación incorrectamente representativo); (3) Ajuste de auditoría #17 (paréntesis aclaratorio sobre `/api/inngest` aplicado). Detalle completo en `MASTER-DOCUMENT-CHANGELOG.md` Parte V. El **v4 queda inmutable como referencia histórica** post-auditoría externa antes del repaso final del operador. **El v5 es el documento que entra a M0 — no habrá más iteración previa a la ejecución.**

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
4. **Edición unificada de contactos en tres sistemas** (Ajuste post-Discovery 2 #14): hoy Centr edita el mismo dato manualmente en Shopify, Whaapy y Excel (nombre, teléfono, dirección, etc.). En Centr Hub, la base maestra vive en la plataforma; Shopify y Whaapy son espejos sincronizados bidireccionales. El vendedor edita donde le sea conveniente y la sincronización propaga transparentemente a los otros dos sistemas.

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
Custom App por tenant con Admin GraphQL API v2026-04. Webhooks consumidos: 3 de customers + 3 de draft_orders + 6 de orders (lista completa en Sección 3.6). HMAC-SHA256 verificado en cada webhook. Idempotencia con dedup. Procesamiento async. Last-write-wins a nivel registro. Backfill inicial vía Bulk Operations.

**3. Sincronización bidireccional con Whaapy — contactos**
La sincronización de contactos con Whaapy es **bidireccional** (Ajuste post-Discovery 2 #14). La base maestra de contactos vive en la plataforma; Shopify y Whaapy son espejos sincronizados. Webhooks consumidos: `contact.created`, `contact.updated`, `contact.deleted`, y el evento que Whaapy provea para asignación de asesor (la sesión de M4 decide cuál según docs actuales). **NO se sincronizan mensajes ni conversaciones** — el vendedor opera todas las conversaciones desde el iframe de Whaapy embebido en la plataforma (pestaña Whaapy), no necesita una vista nativa de mensajes.

**Llamadas salientes a Whaapy:** la plataforma invoca la API saliente de Whaapy para crear contactos cuando llegan customers nuevos de Shopify sin contraparte Whaapy, actualizar contactos con cambios propagados, y asignar contactos al `whaapy_agent_id` mapeado cuando el asesor cambia desde otra fuente. Whaapy api_key cifrado en Supabase Vault.

**Razones del alcance:** la plataforma resuelve el dolor central de Centr de mantener el mismo dato en tres sistemas (Shopify, Whaapy, Excel). El vendedor edita donde le sea conveniente; la sincronización propaga transparentemente. LWW por campo con borrados intencionales propagados (R3 refinada). Defensa anti-bucle obligatoria desde el primer commit (R11).

Identity matching contra contactos Shopify existentes por teléfono E.164 normalizado y email normalizado (lowercase + trim). No se descarga media — esos archivos viven en Whaapy y se ven a través del iframe.

**4. Pipeline kanban dual**
Toggle "Venta / Post-venta" en header. Funnel 1 con 7 etapas pre-cargadas, Funnel 2 con 6 etapas pre-cargadas, todas editables por admin. Drag-and-drop entre etapas con feedback optimista. Virtualización cuando una etapa supera 50 cards. Paginación server-side. Real-time selectivo de updates entre vendedores en la misma vista.

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
| **Contactos** | M6 | **Vista consolidada Shopify + Whaapy.** Un registro por contacto con sus identidades enlazadas; los que existen en ambos sistemas se ven como un solo registro, los que existen solo en uno aparecen igual |
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
Persona física a la que Centr vende. La entidad Contacto en la BD de la plataforma es la **base maestra de contactos — fuente única de verdad**. Shopify y Whaapy son sistemas externos espejados; la plataforma orquesta la sincronización bidireccional para que los tres sistemas (Shopify, Whaapy, base maestra) se mantengan consistentes (Ajuste post-Discovery 2 #14 — ver Observación O11 + Regla R11). Cada contacto maestro tiene columnas `shopify_customer_id` y `whaapy_contact_id` para enlazar las identidades externas; pueden estar ambas, solo una, o ninguna en casos transitorios (contacto recién creado en la plataforma antes de propagar).

*Información relevante:* nombre completo, email normalizado (lowercase + trim), teléfono normalizado a E.164, dirección principal, nota interna, tags de Shopify conservadas como información (independiente del mapeo a asesor), estado del cliente según Shopify (habilitado/deshabilitado/etc.), asesor asignado, **identificadores externos: `shopify_customer_id` y `whaapy_contact_id`** (nullable cada uno), metadatos de last-write-wins **por campo** (timestamp y fuente — R3 aplicada al contact), flag `missing_phone` cuando el contacto llegó sin teléfono, flag de "borrado en Whaapy" y "borrado en Shopify" para auditoría, marca de anonimización ARCO si aplica.

*Relaciones:* un contacto puede tener identidades en Shopify, Whaapy, ambas, o ninguna (en casos transitorios). 0..N oportunidades, 0..N órdenes, 0..N tareas, 0..N notificaciones, 0..N actividades en su timeline.

*Reglas de integridad:* el asesor asignado del contacto **se establece según el sistema que origina la asignación y se propaga al resto**:
- **Asignación originada en Shopify** (vía tag de vendedor en `customers/*`): parser de M3 asigna al maestro; M3 propaga a Whaapy vía API saliente (asignación al `whaapy_agent_id` mapeado del vendedor).
- **Asignación originada en Whaapy** (vía regla nativa de Whaapy entregada por webhook — `conversation.assigned` u otro evento equivalente; M4 decide cuál según docs de Whaapy actuales): M4 resuelve el `whaapy_agent_id` contra membresía organizacional; si match, asigna al maestro Y propaga a Shopify vía API saliente (agregando la tag mapeada del vendedor al customer).
- **Edición manual del admin en M6 (detalle de contacto)**: la plataforma actualiza el maestro inmediatamente y propaga a Shopify Y Whaapy vía APIs salientes.

Si el contacto existe solo en una fuente y la otra no tiene contraparte aún, la plataforma orquesta la creación faltante (ver M3 y M4 para mecánica concreta). El asesor de un contacto puede divergir del asesor de sus oportunidades/órdenes — es regla de negocio explícita, no anomalía (R2). Un contacto anonimizado pierde nombre/email/teléfono pero conserva ID y relaciones para preservar histórico. **Las ediciones desde cualquiera de los tres sistemas se sincronizan automáticamente con los otros dos**; el operador no tiene que mantener tres registros idénticos manualmente (resuelve dolor operativo central de Centr).

**Identidades del contacto** (modelado de transición)
En v5 las identidades externas viven directamente como columnas (`shopify_customer_id`, `whaapy_contact_id`) en la entidad Contacto, no como entidad relacional separada. Esto refleja que en MVP cada contacto tiene como máximo 2 identidades (Shopify + Whaapy). Si V2 expande a más canales (Instagram, Facebook Messenger, etc.), se evalúa migrar a entidad relacional `contact_identities` sin retrabajo del core — la decisión de modelado concreta (columnas vs entidad relacional desde día 1) la toma Claude Code en M1.

*Reglas de integridad:* la combinación de organización + `shopify_customer_id` (cuando no es null) es única. Misma regla para `whaapy_contact_id`. El identity matching durante sincronización opera por teléfono E.164 y email normalizado: si encuentra match con un contacto existente, **agrega la identidad faltante al contacto existente** (no crea duplicado) y dispara propagación al sistema externo donde faltaba.

#### 3.3.4 Grupo C — Pipeline (venta + post-venta)

**Etapa del pipeline**
Cada paso por el que pasa una oportunidad dentro de un funnel. Las etapas son por organización y por funnel — Centr y Rustr pueden tener pipelines distintos; cada funnel tiene su propio set de etapas.

*Información relevante:* nombre visible (ej. "Cotización enviada"), funnel al que pertenece (venta o post-venta), posición en el orden del pipeline, color de display, probabilidad default asociada (solo relevante en Funnel Venta), flag de etapa inicial (la que reciben oportunidades nuevas del funnel), flag de etapa ganada, flag de etapa perdida, flag de "requiere motivo al moverse" (típicamente en etapas perdidas).

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

*Información relevante:* organización, funnel al que aplica, nombre visible, descripción opcional, flag de activación, flag de plantilla (las pre-cargadas vienen como plantillas editables), tipo de trigger (uno de: `stage_aging`, `no_activity`, `created`, `stage_changed`, `won`, `lost`, `contact.created`, `contact.no_activity`), configuración del trigger (estructura libre que parametriza el trigger — ej. "después de cuántas horas en etapa", "qué etapa específica"), lista de condiciones (estructura libre que codifica condiciones como `monto > 5000`, `etapa = "Cotización enviada"`, `asesor in [X, Y]`), lista de acciones (estructura libre que codifica acciones del set permitido: `create_task`, `notify_advisor`, `notify_admin`, `move_to_stage`, `add_tag`), usuario que la creó, timestamps.

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

**Etapas pre-cargadas — Funnel Venta** (7 etapas, editables por admin):

| # | Nombre | Prob. inicial | Tipo |
|---|---|---|---|
| 1 | Lead nuevo | 10% | Inicial |
| 2 | Calificado | 25% | Intermedia |
| 3 | Cotización enviada | 40% | Llegada automática desde Shopify Draft Order |
| 4 | En negociación | 60% | Manual |
| 5 | Esperando pago | 85% | Manual |
| 6 | Ganada | 100% | Ganada (automática al recibir webhook `orders/paid`) |
| 7 | Perdida | 0% | Perdida, requiere motivo |

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
| 1 | Venta | Cotización sin respuesta 24h | `stage_aging` en "Cotización enviada" | 24h en etapa, sin actividad nueva | Tarea automática al asesor: "Hacer seguimiento" |
| 2 | Venta | Oportunidad estancada 72h | `no_activity` | 72h sin actividad, etapa activa (no terminal) | Notificar al asesor + al admin |
| 3 | Venta | Esperando pago tardío | `stage_aging` en "Esperando pago" | >7 días en etapa | Notificar al admin |
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

**Excepción aplicable solo al match inicial:** cuando un contacto de Shopify hace match con uno existente en Whaapy (o viceversa) por primera vez, los campos de Shopify tienen prioridad sobre los de Whaapy en el enriquecimiento inicial (Shopify es la fuente principal de información del contacto en operación de Centr — Discovery 2). Pero si un campo está vacío en Shopify y tiene valor en Whaapy, se preserva el valor de Whaapy (no se borra). Esta excepción aplica únicamente en el momento del primer enlace de identidades; después, LWW por campo universal con borrados propagados.

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
Es válido que una oportunidad de Funnel Venta exista en la plataforma SIN Draft Order todavía: el vendedor capta un lead manualmente, abre una oportunidad, le pone `estimated_amount`, la mueve por las etapas "Lead nuevo" → "Calificado" → "En negociación". Solo cuando crea la Draft Order en Shopify llega el webhook `draft_orders/create` y se asocia. El modelo debe soportar oportunidades con `shopify_draft_order_id` nulo durante esta fase. Cuando llega la asociación, los line items y `amount` real se sincronizan.

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

**O11 — Base maestra de contactos como fuente única de verdad. Shopify y Whaapy son espejos sincronizados.**
Confirmado por el operador en repaso final pre-M0 (mayo 2026) tras revisión de la lógica de contactos. La entidad Contacto en la BD de la plataforma es la **fuente única de verdad** para datos de contactos. Shopify y Whaapy son sistemas externos espejados — la plataforma orquesta sincronización bidireccional para mantener los tres consistentes.

**Justificación operativa:** hoy Centr edita el mismo dato manualmente en tres sistemas (Shopify para venta, Whaapy para mensajería, Excel para reportes). Es dolor operativo central — produce divergencia, errores, y tiempo perdido. Centr Hub resuelve esto al ser la base maestra: el vendedor edita en cualquiera de los tres (Shopify, Whaapy, plataforma) y la sincronización se propaga transparentemente a los otros dos.

**Decisión de modelado:** identificadores externos (`shopify_customer_id`, `whaapy_contact_id`) viven como columnas en la entidad Contacto, no como entidad relacional separada — refleja el caso MVP de máximo 2 identidades por contacto. Si V2 expande a más canales, se migra a entidad relacional `contact_identities` sin retrabajo del core.

**Decisión arquitectónica:** la mecánica de sincronización vive distribuida entre M3 (Shopify inbound + outbound), M4 (Whaapy inbound + outbound) y M6 (edición manual con propagación). CLAUDE.md sección "Sincronización bidireccional de contactos" documenta el flujo de propagación y la regla anti-bucle (R11) — es lectura obligatoria al construir M3, M4, M6.

**Reversión parcial del Ajuste final 5:** la decisión de "Whaapy sincroniza solo contactos sin api_key server-side" del Ajuste final 5 se mantiene parcialmente — Whaapy sigue sincronizando solo contactos (no mensajes, no media), pero **ahora se necesita api_key server-side para llamadas salientes** (crear/actualizar/asignar contactos en Whaapy via API). El iframe sigue usando sesión nativa del navegador para que el vendedor opere conversaciones. Las dos cosas coexisten: iframe para chat operacional + API saliente para sincronización de contactos.

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
- Tokens de proveedores externos viven cifrados en Supabase Vault, descifrados solo dentro del worker que los necesita: **Shopify access_token** (lectura/escritura de customers, draft orders, orders) y **Whaapy api_key** (llamadas salientes para crear/actualizar/asignar contactos vía API — necesario por la sincronización bidireccional del Ajuste post-Discovery 2 #14). El iframe de la pestaña Whaapy usa la sesión nativa del navegador del usuario para operación conversacional — eso no requiere token server-side. La api_key server-side cubre exclusivamente las APIs salientes que orquestan sincronización de contactos.
- Las rutas autenticadas están protegidas por middleware que valida sesión antes de ejecutar lógica. Acceso sin sesión a una ruta autenticada redirige a login.
- Las acciones sensibles del admin (ARCO, desactivar usuario, modificar mapeos de tags) dejan huella en el audit log (3.3.7).


### 3.6 Integraciones externas — vista general

Detalle por proveedor:

#### Shopify

- **API:** Admin GraphQL `2026-04`. Custom App por tenant (no público).
- **Webhooks consumidos (inbound):**
  - **Customers:** `create`, `update`, `delete`.
  - **Draft orders:** `create`, `update`, `delete`.
  - **Orders:** `create`, `updated`, `paid`, `cancelled`, `fulfilled`, `partially_fulfilled`.
- **Llamadas salientes (outbound — Ajuste post-Discovery 2 #14):** la plataforma invoca Shopify Admin API para propagar cambios de contacto originados en Whaapy o en M6 (edición manual). Endpoints típicos: `POST /admin/api/.../customers.json` (crear customer cuando un contacto nuevo de Whaapy no existe en Shopify), `PUT /admin/api/.../customers/{id}.json` (actualizar customer con cambios provenientes de Whaapy o de M6). Agregar/quitar tags de vendedor también vía este endpoint (propagación de asignación de asesor desde Whaapy o desde M6 admin). **Token de Shopify ya en Vault cubre estas llamadas — sin nuevo secret**. Nota operativa importante: Shopify soporta nativamente customers con `orders_count = 0` (la plataforma puede crear un customer en Shopify aunque el contacto no haya hecho compra todavía — útil cuando el contacto nace en Whaapy).
- **Verificación:** HMAC-SHA256 con comparación constant-time antes de parsear JSON.
- **Dedup:** clave en Upstash Redis con namespace dedicado a Shopify, usando `X-Shopify-Event-Id` y TTL de 24h.
- **Defensa anti-bucle (R11):** las llamadas salientes a Shopify se marcan con identificador de origen "plataforma" (header, nota, propiedad custom — Claude Code decide en M3 según lo que la API permita). Webhooks `customers/update` entrantes que lleven ese marcador se descartan + audit log `sync_loop_prevented`.
- **Procesamiento:** la app encola en Inngest con el payload + metadatos del tenant; workers async procesan después y aplican last-write-wins. La respuesta 200 a Shopify se envía en menos de 5 segundos.
- **Tokens:** access_token de la Custom App cifrado en Supabase Vault, asociado a la organización. NO en `.env`. **Cubre tanto lecturas (de webhooks no, viene firma; pero sí para Bulk Operations y reconciliaciones) como las llamadas salientes nuevas del Ajuste #14**.
- **Backfill inicial:** ejecutado en M11 vía Bulk Operations (no consume rate limits significativos). **El alcance es TODO el histórico desde apertura de la tienda Shopify de Centr** (Ajuste post-Discovery 2 #8 — respuesta 2.0 del cliente). NO es rango parametrizable. Scope `read_all_orders` solicitado en M0 es **esencial** (sin este permiso, Shopify limita a últimos 60 días). Expectativa operativa: el backfill puede tardar varias horas según volumen real — Bulk Operations procesa async del lado de Shopify, el operador lanza, espera callback de "completado", y procesa el archivo de resultados por chunks vía Inngest. Si en el futuro otras organizaciones (ej. Rustr) eligen rango menor, ahí sí se parametriza por organización. **La sincronización bidireccional (R11) NO aplica durante el backfill** — el backfill solo crea/enriquece el maestro desde Shopify, no propaga cambios de vuelta a Shopify ni a Whaapy. La propagación bidireccional empieza después del backfill, con webhooks en línea.

#### Whaapy

- **API:** propia, según contrato vigente.
- **Webhooks consumidos (inbound):** `contact.created`, `contact.updated`, `contact.deleted`. **Adicionalmente, M4 consume el webhook que Whaapy provea para "asesor asignado a contacto"** — sea `conversation.assigned`, sea `contact.updated` con campo de asesor cambiado, sea otro evento equivalente; la sesión de M4 decide cuál según docs de Whaapy actuales. La regla operativa es: la plataforma debe enterarse cuando Whaapy asigna asesor a un contacto, para propagar a Shopify (tag mapeada). NO se consumen `message.received`, `message.sent` — los mensajes viven en Whaapy y el vendedor los opera desde el iframe.
- **Llamadas salientes (outbound — Ajuste post-Discovery 2 #14):** la plataforma invoca la API saliente de Whaapy para propagar cambios de contacto originados en Shopify o en M6 (edición manual). Operaciones típicas: crear contacto en Whaapy cuando viene un customer nuevo de Shopify que no existe allá, actualizar contacto con cambios provenientes de Shopify o de M6, asignar contacto a `whaapy_agent_id` cuando el asesor cambia desde otra fuente. **Whaapy api_key necesario server-side para estas llamadas** — vuelve a Vault (revierte parcialmente el Ajuste final 5; ver bloque Vault abajo). Endpoints concretos a decisión de Claude Code en M4 según docs de Whaapy actuales. Whaapy requiere mínimo nombre y teléfono al crear contacto; la plataforma envía todos los campos disponibles del maestro (email, dirección, notas) para que Whaapy quede sincronizado con la maestra.
- **Verificación e idempotencia:** mismo patrón conceptual que Shopify, adaptado al contrato específico de Whaapy. Dedup con namespace distinto en Upstash para separar de Shopify. Eventos no soportados se loguean como `unhandled_whaapy_event` en audit log; notificación al admin SOLO si el mismo evento desconocido aparece >5 veces en 24h.
- **Iframe en plataforma:** la pestaña Whaapy renderiza el chat de Whaapy embebido (técnica validada en Kibah). El vendedor opera todas las conversaciones desde ahí; la plataforma no necesita acceso a los mensajes vía API — para mensajes, el iframe es suficiente y usa la sesión nativa del navegador del usuario.
- **Defensa anti-bucle (R11):** las llamadas salientes a Whaapy se marcan con identificador de origen "plataforma" (la mecánica concreta — propiedad custom, header, comparación de timestamps — la decide Claude Code en M4 según lo que la API de Whaapy permita). Webhooks `contact.updated` entrantes que reflejen un cambio propio se descartan + audit log `sync_loop_prevented`.
- **Identity matching:** webhook de contacto entrante → normalizar phone a E.164 + email a lowercase + trim → buscar contact local existente por estas identidades → si match, **enlazar la identidad Whaapy al contact existente** (puede ya tener identidad Shopify, queda con ambas); si no, crear contact nuevo con identidad Whaapy + disparar creación en Shopify vía API saliente.
- **Sin descarga de media.** No se descargan ni almacenan audios, imágenes ni videos de las conversaciones. Quedan en Whaapy.
- **Asignación de asesor:** dos casos.
  - Contacto Whaapy con match Shopify: hereda `assigned_advisor_id` del contact Shopify si lo tiene; si Whaapy entrega su propia asignación nativa después, gana la más reciente por R3 (LWW por campo).
  - Contacto Whaapy nuevo (sin match Shopify): si Whaapy entrega asignación nativa, se aplica al maestro y se propaga a Shopify al crear el customer correspondiente (tag mapeada del vendedor agregada en la creación). Si no entrega asignación, queda sin asesor hasta asignación manual del admin desde M6.

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
- **Vault:** **Shopify access_token y Whaapy api_key**, ambos cifrados por organización (Ajuste post-Discovery 2 #14 — revierte parcialmente el Ajuste final 5; Whaapy api_key vuelve al Vault ahora que se usa para llamadas salientes desde código, no solo iframe). El iframe sigue usando sesión nativa del navegador para operación conversacional — la api_key server-side cubre exclusivamente APIs salientes de sincronización.
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

**Nota inicial sobre sincronización bidireccional de contactos** (Ajuste post-Discovery 2 #14 — Observación O11): a lo largo del flujo descrito abajo, las ediciones de contactos en cualquiera de los tres sistemas (Shopify, Whaapy, plataforma) se sincronizan automáticamente con los otros dos. El vendedor edita donde le sea más conveniente (Shopify Admin al crear Draft Order, Whaapy al chatear, M6 detalle de contacto en la plataforma) — la sincronización es transparente. La base maestra de contactos vive en la plataforma; Shopify y Whaapy son espejos. M3 y M4 orquestan la propagación con defensa contra bucles (R11).

1. **Captura del lead.** Vendedor habla con prospecto por WhatsApp (desde la pestaña Whaapy con iframe de Whaapy). Si Centr usa Whaapy para inbound, el contacto ya existe sincronizado por M4.
2. **Calificación.** Si decide trabajar el lead, abre detalle de contacto (pestaña Contactos), crea oportunidad manual desde el detalle (M6), captura `estimated_amount` y mueve a etapa "Calificado" (M5).
3. **Cotización.** Cuando llega el momento, vendedor crea Draft Order en Shopify Admin con sus line items, **agrega su tag de atribución al crear el Draft Order** (supuesto operativo confirmado por inferencia — Discovery 2 respuesta 1.3 no fue explícita; el operador asume que es la primera acción del flujo donde el vendedor ya sabe que es su cliente), envía el invoice link desde Shopify al contacto por WhatsApp.
4. **Sincronización automática.** Webhook `draft_orders/create` llega a Centr Hub (M3), parser de tags lee la tag y asigna el vendedor. La oportunidad de la plataforma se actualiza con `shopify_draft_order_id`, line items reales, monto real, y pasa automáticamente a etapa "Cotización enviada" (mediante la lógica del worker — el evento de creación de Draft Order es la señal natural de que la cotización fue enviada).
5. **Seguimiento automático.** Si después de 24h no hay actividad nueva en la oportunidad, regla pre-cargada "Cotización sin respuesta 24h" genera tarea automática "Hacer seguimiento" al asesor (M8). El vendedor la ve en Mi Día (M9).
6. **Negociación.** El vendedor avanza la oportunidad manualmente entre etapas del kanban según el avance real ("En negociación", "Esperando pago").
7. **Pago confirmado.** El cliente paga el invoice link. Shopify cambia el estado de la orden a `paid` y dispara webhook `orders/paid` (M3). El worker mueve la oportunidad de Funnel Venta a etapa "Ganada", y atómicamente crea la oportunidad hija en Funnel Post-venta con etapa "Pago confirmado", heredando contacto y asesor (M7). Toast: "Oportunidad ganada. Se creó seguimiento en Post-venta."
8. **Mantenimiento Post-venta.** La oportunidad en Funnel Post-venta avanza por sus etapas según seguimiento operativo (Preparación → Entregado → Seguimiento post-entrega automático a los 7 días por regla pre-cargada → Cliente activo).
9. **Recompra (idealmente).** Cuando el cliente vuelve a comprar, llega nuevo Draft Order/Order y se crea una oportunidad nueva en Funnel Venta. Las métricas del dashboard reflejan la recompra.

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
4. **Paso 2 — Condiciones:** opcional, agregar cero o más condiciones. Cada una con campo + operador + valor. Ejemplos: "monto > 5000", "etapa = Cotización enviada", "asesor en [Gina, Laura]". Combinables.
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

Esta sección contiene los archivos `CLAUDE.md`, `ERRORES.md` y `UX-FIXES.md` que se inicializan en M0 y viven en la raíz del repo. Cualquier evolución durante el proyecto se hace en los archivos del repo, no en este Master Document.

### 10.1 — CLAUDE.md inicial (a ubicar en raíz del repo en M0)

```markdown
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
Supabase Pro hace backups diarios automáticos. Recuperación manual desde el dashboard de Supabase si hace falta.

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

## Para Claude Code: cuando estás trabajando en un milestone

1. Lee este `CLAUDE.md` primero.
2. Lee `ERRORES.md` para conocer los bugs y workarounds documentados de milestones anteriores.
3. El prompt del milestone correspondiente lo recibes del operador (proviene de `CENTR-MILESTONES-v5.md`, Sección 11). La doctrina del proyecto vive en `CENTR-DOCTRINE-v5.md` adjunto al proyecto — cuando el prompt referencie una sección de doctrina (ej. "Sección 3.2", "R3", "O11"), consulta ahí.
4. Sigue el scope cerrado y `do not modify` del prompt estrictamente.
5. Si encuentras un caso no contemplado en el prompt, **PREGUNTA al operador**, no asumas.
6. Cualquier error nuevo que descubras o workaround que aplique, agrégalo a `ERRORES.md` antes de cerrar el milestone.
7. Cualquier ajuste visual pendiente que detectes durante implementación, agrégalo a `UX-FIXES.md` para que F7 lo procese.
8. Al cerrar el milestone, valida el checklist del prompt antes de hacer el commit final.
```

### 10.2 — ERRORES.md inicial (a ubicar en raíz del repo en M0)

```markdown
# ERRORES.md — Bugs conocidos, workarounds y lecciones del proyecto Centr Hub

> Documento vivo. Cada bug descubierto durante un milestone se documenta aquí antes del commit final del milestone. Permite a milestones posteriores no repetir los mismos errores.

## Estructura de cada entrada

Cada entrada documenta UN bug o lección con la siguiente estructura:

- **Título:** descripción corta del problema.
- **Milestone donde se detectó:** M0, M1, M2, ...
- **Síntoma:** qué se observó.
- **Causa raíz:** qué lo provocó.
- **Workaround / fix:** cómo se resolvió o cómo evitarlo.
- **Lección:** principio general que aplica a milestones futuros.

(Formato y ejemplos ilustrativos en Sección 10.4 del Master Document.)

## Entradas

_(Sin entradas aún — el archivo se popula durante el proyecto.)_
```

### 10.3 — UX-FIXES.md inicial (a ubicar en raíz del repo en M0)

```markdown
# UX-FIXES.md — Ajustes visuales pendientes para F7

> Documento vivo. Cada ajuste visual detectado durante M2-M10 se acumula aquí. F7 (sesión dedicada de diseño post-M10) lo procesa como input principal.

## Estructura de cada entrada

Cada entrada documenta UN ajuste pendiente con la siguiente estructura:

- **Componente o pantalla:** ubicación específica.
- **Issue detectado:** qué se ve mal o falta polish.
- **Sub-sesión de F7 sugerida:** A (públicas/login) | B (layout/dashboard) | C (componentes funcionales) | D (admin/configuración).
- **Severidad:** alta | media | baja.

(Formato y ejemplos ilustrativos en Sección 10.4 del Master Document.)

## Entradas

_(Sin entradas aún — el archivo se popula durante M2-M10.)_
```

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


