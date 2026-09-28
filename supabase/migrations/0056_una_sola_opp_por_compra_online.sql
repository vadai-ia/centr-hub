-- 0056 — Una sola oportunidad de Post-venta por COMPRA ONLINE.
--
-- Causa del duplicado: los webhooks de un mismo pedido (create, paid,
-- updated) llegan casi simultáneos y cada uno corre
-- `ensureOnlineOrderOpportunity`. Su guarda es `orders.opportunity_id`, que
-- se LEE y luego se ESCRIBE: en una carrera los tres la leen vacía antes de
-- que el primero enlace, y los tres crean tarjeta. Medido en producción:
-- tres cards del mismo pedido creadas en 241 ms.
--
-- La guarda de aplicación no puede cerrar esto sola (no hay transacción
-- entre leer y escribir), así que el invariante vive en la BD.
--
-- Idempotente y NO destructiva: las sobrantes se CANCELAN (patrón
-- "cancelado ≠ perdido" de 0014), no se borran — el kanban ya excluye
-- canceladas, y el historial de cada una queda consultable.

-- 1) Sanear lo existente: conservar la que el pedido tiene enlazada (si no,
--    la más antigua) y cancelar las demás.
with vivas as (
  select
    o.id,
    o.organization_id,
    o.shopify_order_id,
    row_number() over (
      partition by o.organization_id, o.shopify_order_id
      order by (ord.opportunity_id = o.id) desc nulls last, o.created_at asc
    ) as rn
  from public.opportunities o
  left join public.orders ord
    on ord.organization_id = o.organization_id
   and ord.shopify_order_id = o.shopify_order_id
  where o.funnel = 'post_venta'
    and o.parent_opportunity_id is null
    and o.shopify_order_id is not null
    and o.cancelled_at is null
)
update public.opportunities o
set cancelled_at = now(),
    cancellation_source = 'duplicate_online_order',
    cancellation_note = 'Duplicada por webhooks simultáneos del mismo pedido (0056).'
from vivas v
where v.id = o.id
  and v.rn > 1;

-- 2) El invariante: una sola opp de Post-venta SIN MADRE viva por pedido.
--    No toca a las hijas del trigger F1→F2 (esas llevan madre).
create unique index if not exists opportunities_una_online_por_pedido
  on public.opportunities (organization_id, shopify_order_id)
  where funnel = 'post_venta'
    and parent_opportunity_id is null
    and shopify_order_id is not null
    and cancelled_at is null;
