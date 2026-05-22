# PENDIENTES.md — Deuda técnica diferida entre milestones

> Documento vivo. Tareas que no bloquean el milestone actual pero deben atacarse en milestones futuros o cuando aplique.
>
> Cada entrada incluye: qué hay que hacer, por qué se difirió, y dónde está el contexto original (ERRORES.md / CLAUDE.md / commit hash).

## M6

- **Validación E2E de defensa anti-bucle (R11)** — diferido desde M3 CHECKPOINT manual. R11 está implementada y validada con 6 tests Vitest sintéticos en `lib/services/sync-loop-defense.ts`. El test E2E natural requiere disparar un UPDATE outbound a un customer desde la plataforma, lo cual no es posible en M3 (sin UI). Cuando M6 implemente el botón de editar contacto + el botón "Crear contacto en Shopify", validar: edit en plataforma → PUT a Shopify → webhook entrante con cambio propio → descarte con audit log `sync_loop_prevented`. Ver `ERRORES.md` entrada "Falso positivo posible en R11" y `lib/services/sync-loop-defense.ts` para contexto.

## Sin asignar

(Vacío por ahora — se irá llenando)
