-- ============================================================
-- Cambio · 0036 — orders.delivery_status (estado de ENTREGA de Shopify)
-- ============================================================
-- El motor de transiciones de Post-venta (M3v2) movía "Envío en curso" y
-- "Entregado" según `orders.fulfillment_status` (estado de PREPARACIÓN del
-- pedido: null/partial/fulfilled = ¿se despacharon los ítems?).
--
-- Centr necesita que esas dos etapas se rijan por el estado de ENTREGA
-- (lo que Shopify muestra en la columna "Estado de la entrega"), que es
-- distinto de la preparación: refleja el avance real del paquete con el
-- cliente final (carrier FedEx auto-actualiza). En la API ese estado vive
-- en el FULFILLMENT individual (`displayStatus` / `shipment_status`), no en
-- el campo `fulfillment_status` del pedido.
--
-- Esta columna guarda el estado de entrega NORMALIZADO del pedido,
-- derivado de sus fulfillments:
--   'delivered'   → al menos un fulfillment entregado y ninguno pendiente
--                   de entrega (Shopify "Entregado").
--   'in_progress' → hay fulfillment con seguimiento generado y aún no
--                   entregado (Shopify "Seguimiento añadido" / en tránsito).
--   NULL          → sin fulfillment / sin seguimiento → sin señal de
--                   entrega (la opp permanece en su etapa de PAGO).
--
-- Captura SOLO-LECTURA con el scope `read_orders` que ya tenemos (el objeto
-- Fulfillment se lee con read_orders): el cron horario refresca esta columna
-- vía GraphQL para las opps de Post-venta no entregadas, y el hook inline de
-- orders/* la actualiza desde los fulfillments embebidos del payload. NO se
-- suscribe el webhook fulfillments/* (eso exigiría read_fulfillments +
-- re-instalación de la app — innecesario para la latencia de Post-venta).
--
-- Nullable: las filas previas quedan NULL hasta que el correctivo
-- `backfill-order-delivery-status` o el cron las pueble. Una opp sin señal
-- de entrega no avanza a Envío/Entregado: se queda donde la deje el pago.
-- ============================================================

alter table public.orders
  add column delivery_status text;

comment on column public.orders.delivery_status is
  'Estado de ENTREGA normalizado del pedido (derivado de los fulfillments de Shopify): delivered = entregado al cliente; in_progress = seguimiento añadido / en tránsito, aún no entregado; NULL = sin señal de entrega. Distinto de fulfillment_status (preparación). El motor de Post-venta mueve Envío en curso / Entregado por esta columna. Capturada solo-lectura vía read_orders (cron + hook orders/*). NULL en filas pre-fix hasta el correctivo backfill-order-delivery-status.';

-- Índice parcial: el cron itera opps de Post-venta y refresca delivery_status
-- de las NO entregadas. Acota la enumeración de "qué falta por entregar".
create index orders_org_delivery_status_idx
  on public.orders (organization_id, delivery_status)
  where delivery_status is distinct from 'delivered';
