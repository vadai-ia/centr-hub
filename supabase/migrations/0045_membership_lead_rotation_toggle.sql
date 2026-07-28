-- ============================================================
-- Leads · 0045 — Toggle por-vendedor de pertenencia al reparto round-robin
-- ============================================================
-- El reparto round-robin de leads que entran por WEBHOOK (0038 — Meta y
-- futuras campañas) reparte entre los vendedores elegibles. Hasta ahora el
-- pool era "todos los vendedores activos reales" (listActiveRealVendors). Se
-- agrega un toggle admin-gestionable por vendedor para sacarlo/meterlo a la
-- rotación SIN desactivar su acceso ni cambiar su rol.
--
-- Default TRUE: todo el que hoy es elegible SIGUE elegible (sin cambio de
-- comportamiento al aplicar la migración). El admin apaga el flag para que un
-- vendedor deje de recibir leads automáticos (sigue tomando leads a mano).
--
-- Alcance: SOLO afecta el pool del round-robin de webhooks. NO toca:
--   - Leads de origen Whaapy (heredan el asesor del agente) ni Shopify.
--   - Oportunidades Outbound (nunca entran a la rotación).
--   - Asignación/reasignación manual, atribución por tag, ni ningún selector
--     de vendedor (esos siguen usando listActiveRealVendors sin filtrar).
-- El admin (rol no-vendedor) nunca estuvo en la rotación y sigue fuera.

ALTER TABLE public.memberships
  ADD COLUMN IF NOT EXISTS in_lead_rotation boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.memberships.in_lead_rotation IS
  'Round-robin de leads por webhook (0045): true = recibe leads automáticos; '
  'false = fuera de la rotación (sigue tomando leads a mano). Solo aplica a '
  'vendedores; ignorado para otros roles. Default true = elegible.';
