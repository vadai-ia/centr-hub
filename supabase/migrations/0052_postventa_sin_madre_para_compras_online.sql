-- ============================================================
-- Post-venta sin madre para compras ONLINE · 0052
-- ============================================================
-- `opportunities_parent_funnel_check` (0004, extendida en 0040) exige que
-- TODA oportunidad de Post-venta tenga `parent_opportunity_id`. Ese
-- invariante codifica un supuesto del modelo v5.1: la hija de Post-venta
-- nace del trigger F1→F2 a partir de una opp de Venta, que a su vez nació
-- de un Draft Order.
--
-- Una COMPRA ONLINE rompe la cadena por arriba: el cliente compra directo
-- en la tienda, no hay cotización, no hay borrador y por lo tanto no hay
-- madre de la cual colgar. Consecuencia medida en producción: 294 de 294
-- pedidos online quedaron sin ninguna oportunidad — invisibles para
-- Post-venta, que no podía darles seguimiento.
--
-- ## Qué se relaja, y qué NO
--
-- Se admite `post_venta` sin madre SOLO si está anclada a un pedido
-- (`shopify_order_id is not null`). El invariante de fondo se conserva: una
-- oportunidad de Post-venta siempre tiene procedencia demostrable — o
-- desciende de una venta trabajada, o apunta a un pedido real.
--
-- Lo que sigue prohibido es una hija de Post-venta suelta, sin madre y sin
-- pedido: eso no sería una compra online, sería una fila huérfana.
--
-- `venta` y `outbound` no cambian: siguen exigiendo `parent` NULL.
--
-- NO toca datos: solo amplía qué filas se admiten. Toda fila existente ya
-- satisface la condición nueva (la vieja es un subconjunto de ésta).
-- ============================================================

ALTER TABLE public.opportunities
  DROP CONSTRAINT IF EXISTS opportunities_parent_funnel_check;

ALTER TABLE public.opportunities
  ADD CONSTRAINT opportunities_parent_funnel_check CHECK (
    (funnel = 'venta'      AND parent_opportunity_id IS NULL) OR
    (funnel = 'outbound'   AND parent_opportunity_id IS NULL) OR
    (funnel = 'post_venta' AND parent_opportunity_id IS NOT NULL) OR
    -- Compra online: sin madre, pero anclada a su pedido.
    (funnel = 'post_venta'
      AND parent_opportunity_id IS NULL
      AND shopify_order_id IS NOT NULL)
  );

COMMENT ON CONSTRAINT opportunities_parent_funnel_check ON public.opportunities IS
  'Procedencia de la oportunidad (R1 + 3.3.4, ampliado en 0040 y 0052). '
  'Venta y Outbound nacen sin madre. Post-venta desciende de una Venta '
  'trabajada (trigger F1→F2) O, cuando la venta entró sola por la tienda '
  'online y nunca hubo cotización, cuelga directamente de su pedido. Una '
  'Post-venta sin madre NI pedido sigue prohibida: sería una fila huérfana.';
