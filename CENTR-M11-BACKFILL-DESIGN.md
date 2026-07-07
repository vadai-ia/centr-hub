# M11 — Backfill de contactos (Shopify) + órdenes — Diseño

> **Status: DRAFT — esperando aprobación del operador antes de construir.**
> Scope corregido: 2026-07-06. Basado en auditoría read-only de datos reales
> (4 scripts en `scripts/shopify/` y `scripts/whaapy/`, ejecutados 2026-07-06).

---

## 1. Scope

**Dentro:**
- Los **1,103 customers de Shopify** (tienda `CENTR x HYROX`) → tabla `contacts`.
- Sus **órdenes** (487 con ≥1 orden) → tablas `orders` / `order_line_items`, y las
  oportunidades de Venta que cuelgan de Draft Orders → `opportunities`.

**Fuera (corrección de scope 2026-07-06):**
- **NO se importan los 7,288 contactos de Whaapy.** Son ruido histórico — muchos
  ya no son clientes. La sincronización real-time de Whaapy (M4) queda **intacta**:
  todo contacto nuevo que entre a Whaapy después del backfill se guarda en la
  plataforma por el flujo existente. No se toca.

**Consecuencia clave:** todo el riesgo de duplicación cross-system Whaapy↔Shopify
(los 360 pares should-link, los 328 fallos de normalización, los 13 loose-only)
**sale de la mesa** — no importamos Whaapy. La auditoría Whaapy queda como
referencia histórica, no como trabajo de este milestone.

---

## 2. Lo que ya es seguro sin trabajo adicional (dedup por clave, DB-constrained)

La idempotencia de las entidades con identidad externa ya está garantizada por
constraints UNIQUE en BD — re-correr el backfill N veces no duplica:

| Entidad | Constraint | Path de dedup |
|---|---|---|
| `contacts` | `unique (organization_id, shopify_customer_id)` (mig. 0003) | `findContactByShopifyCustomerId` → update, no insert |
| `orders` | `unique (organization_id, shopify_order_id)` (mig. 0005) | `findOrderByShopifyOrderId` → LWW update |
| `opportunities` | `unique (organization_id, shopify_draft_order_id)` (mig. 0004) | `findOpportunityByDraftOrderId` → update |

Crear los 1,103 customers deduplicados por `shopify_customer_id` es **seguro y
re-ejecutable**. Esta mitad no necesita hardening.

---

## 3. El único riesgo de correctitud que este milestone SÍ debe resolver

**Merge-collapse por teléfono compartido entre dos customers de Shopify.**

El matcher actual (`matchContactIdentity`, tier 2 = phone) devuelve **cualquier**
contacto con ese teléfono, incluyendo uno que ya tiene `shopify_customer_id` de
**otro** customer. El worker `customersCreate` sólo setea `shopify_customer_id`
si el contacto matcheado no tiene uno; si ya lo tiene, **no lo sobreescribe y
fusiona los campos del segundo customer sobre el primero vía LWW**. Resultado:
dos customers distintos de Shopify colapsan en un solo `contact`, y el segundo
`shopify_customer_id` nunca se persiste.

**Blast radius medido (auditoría 2026-07-06):** 32 números normalizados
compartidos por >1 customer, **74 customers** involucrados. De esos:
- **1 número placeholder** (`+525512345678`) compartido por **12 customers**.
- **31 números ×2** (pares — pareja/negocio que comparte teléfono real).

Sin fix, el backfill fusionaría ~62 customers legítimos (los ×2, 2º en importar)
+ colapsaría los 12 del placeholder.

### Fix (acotado al path de backfill)

1. **El tier-phone del backfill sólo enlaza a LEADS** (`shopify_customer_id IS
   NULL`). Un match de teléfono contra un contacto que **ya tiene**
   `shopify_customer_id` (otro customer de Shopify) se **ignora** → el customer
   entrante crea su propia fila (deduplicada por su `shopify_customer_id`). Esto
   preserva el dedup legítimo que SÍ queremos (Shopify customer entrante ↔ lead
   pre-existente en la plataforma → el lead se vuelve cliente) sin fusionar dos
   clientes de Shopify. Los ×2 quedan como dos filas, cada una con su teléfono.

2. **Blocklist de placeholder.** Un teléfono compartido por **≥3 customers**
   (hoy = sólo `+525512345678`) se trata como placeholder: NO actúa como clave
   de match, y los customers que lo llevan se importan **sin teléfono** +
   `missing_phone = true` (la pestaña Contactos ya muestra el tag "sin teléfono"
   → el admin los revisa: cuáles son test vs cliente real). El número fake nunca
   se persiste como `phone`.

> Nota: el mismo merge-collapse es un bug **latente en el flujo live** (dos
> `customers/*` webhooks con teléfono compartido). Arreglarlo en el matcher live
> queda **fuera de scope** de este milestone (ver §7) — se registra como entrada
> candidata en `ERRORES.md`/`PENDIENTES.md`. Este milestone lo neutraliza sólo
> en el path de backfill.

---

## 4. Decisiones de diseño (locked)

- **Single-thread el import de contactos.** Con 1,103 customers el volumen es de
  minutos — no hay Bulk Operations ni chunks paralelos. Single-thread elimina de
  raíz cualquier race read-then-write sin constraint (el tier-phone no tiene
  constraint que lo respalde).
- **Placeholder blocklist** (§3.2): `+525512345678` → los 12 phoneless + "sin
  teléfono".
- **Matcher estricto, SIN fallback last-10.** La auditoría mostró que el fallback
  compraría ~7 enlaces marginales (mayormente ambos lados sucios) en toda la
  historia, con riesgo de falsos merges a escala. No se toca el hot path; esos
  casos se cubren con el reporte de reconciliación (§6).
- **Dry-run primero.** El backfill corre en modo `--dry-run` (read-only, reporta
  qué haría) y requiere sign-off antes del run real.
- **Idempotente.** Re-correr = no-op sobre lo ya importado (dedup por clave §2).
- **`backfill_in_progress = true` durante todo el run.** Suprime:
  - el outbound Shopify→Whaapy (`recordWhaapySyncIntent` / `create_from_shopify`)
    — no queremos crear 685 contactos en Whaapy;
  - la auto-creación C2/R12 de oportunidades;
  - el motor de transiciones de Post-venta y triggers acoplados.
  Se restaura a `false` en `finally` (incluso si falla), patrón de
  `backfill-incremental.ts`.
- **Audit logging** de inicio/fin + cada conflicto (§6).

---

## 5. Hechos de datos (auditoría read-only 2026-07-06)

| Métrica (Shopify source) | Valor |
|---|---|
| Total customers | 1,103 |
| Con teléfono usable | 685 |
| Teléfono que NO normaliza a E.164 | 2 (negligible) |
| Sin teléfono | 418 → import phoneless + "sin teléfono" |
| Sin teléfono NI email | 91 → islas no enlazables (correcto) |
| Con ≥1 orden | 487 |
| Números normalizados compartidos por >1 customer | 32 (74 customers) |
| Placeholder `+525512345678` | 1 número / 12 customers |

`contacts` actual (ya importado por corridas previas): 288 filas (285 clientes,
3 leads), 0 colisiones de teléfono existentes.

---

## 6. Reporte de reconciliación post-import (re-scopeado)

Read-only, admin-facing (script/CSV para MVP). Cubre **sólo conflictos del lado
Shopify contra contactos que ya existen en la plataforma** — ya NO cubre nada de
Whaapy import:

- Customers cuyo teléfono matcheó **>1 lead** pre-existente → `conflict_create_new`
  → fila nueva creada, marcada para revisión.
- Los **12 del placeholder** (importados phoneless) → el admin decide test vs real.
- Pares de teléfono compartido ×2 (dos filas con mismo teléfono) → informativo.
- Customers phoneless / sin identificador fuerte (91) → informativo (el tag "sin
  teléfono" ya los expone en la UI).

Es esencialmente `audit-loose-only.ts` productizado y acotado al lado Shopify.

---

## 7. Fuera de scope (explícito)

- Import de los 7,288 contactos de Whaapy.
- Fallback last-10-dígitos en el matcher live (~7 enlaces marginales; no vale el
  riesgo — cubierto por §6).
- Fix del merge-collapse por teléfono compartido en el **flujo live** (webhooks
  `customers/*`) → registrar como candidato en `ERRORES.md`/`PENDIENTES.md`, no
  se construye aquí.
- Shopify Bulk Operations / GraphQL bulk export / chunks Inngest — el volumen
  (1,103) no lo justifica; REST paginado single-thread basta. (Esto **re-scopea**
  la visión original de M11 en la doctrina, que asumía "varios años / miles".)
- **Reconstrucción de pipeline histórico** — avanzar los ~495 drafts completados
  a "Ganada" con su hija de Post-venta para analítica de win-rate histórico. Es
  un milestone aparte; este backfill solo trae los ~552 cotizaciones en curso.

---

## 8. Decisiones — RESUELTAS (2026-07-06)

1. **Umbral de placeholder → LOCKED: teléfono compartido por ≥3 customers.**
   Hoy aísla exactamente `+525512345678` y captura cualquier cluster placeholder
   futuro. Esos customers → phoneless + `missing_phone` + tag "sin teléfono".
2. **Pares ×2 (teléfono compartido real) → LOCKED: importar ambos, filas
   separadas, conservar teléfono, sin fusionar** (§3.1). Son personas reales
   distintas que comparten número (parejas, etc.).
3. **Bug live del merge-collapse → LOCKED: diferido.** Es un bug del path de
   webhooks live, no del backfill. Se mantiene el milestone limpio. Registrado en
   `ERRORES.md` ("Teléfono compartido entre dos customers de Shopify los fusiona
   … LATENTE en flujo live") con la regla y las referencias de código para que no
   se pierda. El backfill lo neutraliza sólo en su path.
4. **Reporte de reconciliación → LOCKED: script CSV/stdout (MVP).** ~7–30 filas
   no justifican pantalla UI; un CSV que el admin revisa basta.
5. **Opps de Draft Order → LOCKED (tras dry-run 2026-07-06): solo open/invoice_sent.**
   El dry-run reveló 1,047 drafts = **550 open + 2 invoice_sent + 495 completed**.
   Los **495 completados se OMITEN** — son ventas cerradas que ya viven como
   `orders` (su revenue está ahí); traerlos como "Cotización" inundaría el
   pipeline con ~495 ventas pasadas en la primera etapa (F1→F2 suprimido → no
   avanzarían a Ganada). Se crean solo los ~552 en curso. La reconstrucción de
   win-rate histórico (completadas → Ganada) es un milestone aparte (§7).
6. **Corte de fecha en ÓRDENES → LOCKED (operador 2026-07-07): solo desde
   2026-06-01 CDMX.** Centr usa la plataforma de aquí en adelante y solo le
   importan métricas desde junio 2026; el archivo viejo (mayoría de los 578
   archivados) es peso muerto. Se omiten las órdenes con `created_at` anterior a
   2026-06-01T00:00 America/Mexico_City. **Aplica SOLO a órdenes** — contactos se
   traen TODOS (sin corte) y las opps mantienen open-only sin corte. Esto
   re-scopea el "backfill de TODO el histórico" de la doctrina para órdenes: es
   decisión operativa consciente, no drift.

---

## 9. GSD — Checklist de aprobación (gate antes de construir)

Las 4 decisiones de §8 están LOCKED. Falta el sign-off global del operador sobre
este diseño antes de escribir código.

**Pre-build (decisiones — resueltas 2026-07-06):**
- [x] Scope: Shopify contacts (1,103) + orders; NO Whaapy import.
- [x] Fix del merge-collapse (tier-phone → sólo leads, nunca pisar un contacto con
      otro `shopify_customer_id`).
- [x] Placeholder: teléfono compartido por ≥3 customers → phoneless + "sin teléfono".
- [x] Pares ×2: importar ambos, filas separadas, conservar teléfono, sin fusionar.
- [x] Bug live: diferido + entrada en `ERRORES.md` (hecha).
- [x] Reporte de reconciliación: script CSV/stdout (MVP).

**Gate de aprobación (APROBADO 2026-07-06 por el operador):**
- [x] **APROBAR el diseño completo — autoriza empezar el build (T1–T5).**

**Build (tareas — COMPLETADAS 2026-07-06):**
- [x] T1 — `scripts/shopify/backfill-shopify-full.ts` con `--dry-run` (default) /
      `--commit`, single-thread, `backfill_in_progress` guard, REST paginado
      (`shopifyRestCollection`, Link header). Solo `slug==='centr'`.
- [x] T2 — Matching: dedup por `shopify_customer_id`; tier-phone/email restringido
      a leads (`findLeadsByPhone`/`findLeadsByEmail` → `is shopify_customer_id null`);
      placeholder (≥3 shared) → phoneless + `missing_phone`. Lógica pura en
      `lib/services/backfill-contact-decision.ts`.
- [x] T3 — Órdenes + line items + opps de Draft Order **solo open/invoice_sent**
      (dedup por `shopify_order_id` / `shopify_draft_order_id`). Completados omitidos.
- [x] T4 — Reporte de reconciliación CSV (`backfill-recon-report.csv`) con los buckets de §6.
- [x] T5 — `tests/backfill-contact-decision.test.ts` (10 tests, 10/10 pass):
      dedup idempotente, teléfono compartido → sin merge, placeholder → phoneless,
      customer ↔ lead pre-existente → link, >1 lead → conflict, + guards de fuente.

**Success criteria (validar antes del commit final):**
- [ ] Dry-run (open-only) revisado y firmado por el operador. ← **gate actual**
- [ ] Run real: contactos importados (o el delta), 0 merges de clientes distintos,
      12 placeholder phoneless, ~552 cotizaciones (open-only), 0 outbound a Whaapy.
- [ ] Re-correr el backfill = no-op (idempotencia probada).
- [ ] Reporte de reconciliación generado y entregado al admin.
- [x] Entrada en `ERRORES.md` (merge-collapse live) — hecha.
