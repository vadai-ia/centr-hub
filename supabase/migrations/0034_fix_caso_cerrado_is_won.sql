-- ============================================================
-- Post-venta · 0034 — corrective: "Caso cerrado" sin is_won en orgs
--                       pre-renombradas a mano (M4v2)
-- ============================================================
-- 0033 marcó la terminal de Post-venta "Caso cerrado" (is_won + color)
-- keyeando el UPDATE de orgs existentes por `name = 'Cliente activo'` (el
-- nombre SEMILLA). Pero al menos una org (Centr) ya tenía esa etapa
-- renombrada A MANO en la BD viva a "Caso cerrado" ANTES de 0033 — así que
-- el `WHERE name='Cliente activo'` NO la matcheó y quedó como
-- `is_won = false` (no archiva) mientras Rustr (que aún tenía el nombre
-- semilla) sí quedó correcta.
--
-- LECCIÓN: una migración de datos que matchea filas vivas por una columna
-- MUTABLE (name) salta en silencio cualquier fila editada a mano. El
-- correctivo debe keyear por el ESTADO OBJETIVO y ser idempotente.
--
-- Este UPDATE es idempotente y auto-corrige: solo toca filas Post-venta
-- llamadas "Caso cerrado" que AÚN no tienen is_won. En orgs ya correctas
-- (Rustr, o cualquier bootstrap nuevo que ya nace con is_won=true) el
-- `AND is_won = false` lo vuelve no-op. No toca ninguna otra etapa.
-- ============================================================

update public.pipeline_stages
   set is_won = true,
       color  = '#0D9488'
 where funnel = 'post_venta'
   and name   = 'Caso cerrado'
   and is_won = false;
