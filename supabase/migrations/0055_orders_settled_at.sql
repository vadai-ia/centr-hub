-- ============================================================
-- Cambio · 0055 — orders.settled_at (cuándo el pedido quedó LIQUIDADO)
-- ============================================================
-- Centr cobra una parte de la venta por adelantado y el resto después, y lo
-- marca con una etiqueta de Shopify (`Anticipo50%`, `Anticipo60%`, …).
-- Decisión de la dirección: **cada mitad se registra en SU propio mes** — el
-- anticipo en el mes en que entró, y el resto en el mes en que el pedido se
-- finaliza. Sin esta columna la segunda mitad no tiene fecha a la cual caer.
--
-- Por qué NO alcanza `paid_at`: esa columna guarda el `processed_at` de
-- Shopify, que es CUÁNDO SE PROCESÓ EL PEDIDO, no cuándo terminó de pagarse.
-- Verificado en producción: un pedido en estado `pending` (sin liquidar) ya
-- trae `paid_at`. Usarla para la segunda mitad metería las dos en el mismo
-- mes, que es justo el problema que se quiere resolver.
--
--   paid_at    → el pedido se procesó (y con él entró el anticipo).
--   settled_at → `financial_status` pasó a 'paid' (el cliente liquidó).
--
-- La escribe el worker de `orders/*` al ver la transición a 'paid', y solo
-- cuando está NULL: una vez liquidado, la fecha no se mueve aunque lleguen
-- más webhooks del mismo pedido (un cambio de nota dispara orders/updated).
--
-- Backfill: los pedidos YA pagados quedan con `settled_at = paid_at`. Es una
-- aproximación consciente — de los históricos no existe registro de cuándo
-- se liquidaron — y deja el comportamiento IGUAL que hoy para ellos: las dos
-- mitades caen en el mismo mes, así que ningún número histórico se mueve por
-- esta migración. El criterio nuevo aplica de aquí en adelante.
-- ============================================================

alter table public.orders
  add column if not exists settled_at timestamptz;

comment on column public.orders.settled_at is
  'Momento en que el pedido quedó LIQUIDADO (financial_status pasó a paid). Distinto de paid_at, que es el processed_at de Shopify (cuándo se procesó el pedido; un pedido pending ya lo trae). Lo usa el reconocimiento de ingresos por anticipo: el anticipo cuenta en el mes de paid_at y el resto en el mes de settled_at. La escribe el worker de orders/* solo cuando está NULL.';

-- Backfill: lo ya pagado se considera liquidado cuando se procesó.
update public.orders
set settled_at = paid_at
where financial_status = 'paid'
  and settled_at is null
  and paid_at is not null;

-- El dashboard busca pedidos cuya SEGUNDA mitad cae en el periodo.
create index if not exists orders_org_settled_at_idx
  on public.orders (organization_id, settled_at)
  where settled_at is not null;
