-- ============================================================
-- Fix crítico · 0024 — orders.shopify_created_at (fecha real de Shopify)
-- ============================================================
-- La tabla orders solo tenía `created_at` (cuándo el registro entró a
-- la BD local). El dashboard contaba "Pedidos en el periodo" y "Pedidos
-- por mes" por ese campo, produciendo conteos falsos: una carga/sync
-- masivo metió 69 órdenes el 4-jun cuyo pedido en Shopify es de
-- noviembre-2025 a abril-2026, contadas todas como de junio.
--
-- Esta columna guarda el `created_at` del OBJETO Order de Shopify (la
-- fecha real de creación del pedido allá), independiente de cuándo
-- aterrizó en la BD. El sync (M3) la popula de ahora en adelante; el
-- backfill de M11 la traerá poblada desde el inicio; el correctivo
-- `backfill-order-shopify-created-at.ts` rellena las órdenes existentes.
--
-- Nullable: las filas previas quedan NULL hasta el correctivo. El
-- dashboard filtra por `shopify_created_at` (gte/lte), así que las NULL
-- simplemente no se cuentan en ningún periodo hasta que se pueblen — el
-- comportamiento deseado (una fecha desconocida no debe inventarse).
--
-- Revenue (paid_at) NO se toca. KPIs de Venta (fechas de opportunities)
-- NO se tocan.
-- ============================================================

alter table public.orders
  add column shopify_created_at timestamptz;

comment on column public.orders.shopify_created_at is
  'created_at del objeto Order de Shopify (fecha real de creación del pedido allá). Distinto de created_at (entrada a la BD local). NULL en filas pre-fix hasta el correctivo backfill-order-shopify-created-at. El dashboard cuenta pedidos por esta columna, no por created_at.';

-- Índice para el filtro/agrupación del dashboard ("Pedidos en el
-- periodo" / "Pedidos por mes" por fecha de Shopify).
create index orders_org_shopify_created_at_idx
  on public.orders (organization_id, shopify_created_at desc)
  where shopify_created_at is not null;
