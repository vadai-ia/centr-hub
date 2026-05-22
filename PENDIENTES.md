# PENDIENTES.md — Deuda técnica diferida entre milestones

> Documento vivo. Tareas que no bloquean el milestone actual pero deben atacarse en milestones futuros o cuando aplique.
>
> Cada entrada incluye: qué hay que hacer, por qué se difirió, y dónde está el contexto original (ERRORES.md / CLAUDE.md / commit hash).

## M4

- **M4-DT-01 — Test sintético del orden de operaciones en `whaapyContactUpdated`.** Cobertura faltante: (a) R11 timestamp descarta → no propaga Shopify; (b) R11 marker descarta → no propaga Shopify; (c) LWW sin cambios → no propaga Shopify; (d) sin `shopify_customer_id` → no propaga (asimetría). Bloqueador resuelto: el approach de cast `as unknown as InngestFnLike` falla por cómo Vitest inspecciona el mock de Inngest. Patrón a seguir: extraer la lógica del handler a funciones puras testeables (como hace M3 con `sync-loop-defense.ts` y `last-write-wins.ts`) y testear esas funciones, no el wrapper Inngest. No bloqueante — comportamiento validado empíricamente en CHECKPOINT M4 (commit `e377e2f`). Estimar 2-3h.

- **M4-DT-02 — Validación E2E de `conversation.assigned` happy path.** Bloqueado operativamente: Gina y Pepe no están dados de alta como agentes en Whaapy todavía (mayo 2026). Sin alta, el `assigned_to` de `conversation.assigned` no puede mapear a `memberships.whaapy_agent_id`, y el worker queda atrapado siempre en la rama `whaapy_agent_mapping_missing` (comportamiento correcto del código, no bug). Pendientes operativos cuando Centr dé de alta a los vendedores en Whaapy: (1) `GET /team/v1` para obtener UUIDs reales; (2) `UPDATE memberships SET whaapy_agent_id = '<uuid>' WHERE id IN ('c561a28d-661a-430a-9353-3e98b9dfab65', '08f57a57-64cd-44e4-95d5-a68a22c247ec');` (3) re-correr item 4.5 del CHECKPOINT M4 (asignar conversación → verificar propagación tag a Shopify). No bloqueante para cerrar M4 — el happy path queda validado sintéticamente vía `whaapy-webhook-endpoint.test.ts` y tests de mapping. Estimar 1h cuando llegue el momento.

## M6

- **Validación E2E de defensa anti-bucle (R11)** — diferido desde M3 CHECKPOINT manual... 

