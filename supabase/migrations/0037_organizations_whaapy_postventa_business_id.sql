-- ============================================================
-- Integración Post-venta ↔ Whaapy Post-venta · 0037
-- ============================================================
-- Agrega el discriminador del SEGUNDO Whaapy (el de Post-venta), una
-- instancia INDEPENDIENTE del Whaapy de Venta ya integrado.
--
--   whaapy_postventa_business_id  text  — businessId del negocio en el
--     Whaapy de Post-venta. Whaapy lo emite en el ROOT de cada payload de
--     webhook (`{ event, businessId, data }`). El endpoint entrante
--     `/api/webhooks/whaapy-postventa` lo usa para resolver el tenant, tal
--     como `whaapy_business_id` (0002) lo hace para el Whaapy de Venta.
--
-- Espejo exacto de `whaapy_business_id` (0002): nullable + UNIQUE. El
-- UNIQUE impide que dos orgs reclamen el mismo negocio Whaapy. Nullable
-- porque una org sin integración Post-venta simplemente lo deja NULL.
--
-- Nota multi-tenant: al ser una columna separada de `whaapy_business_id`,
-- un webhook de Venta (con el businessId de Venta) NUNCA resuelve por esta
-- columna y viceversa — el aislamiento entre ambos Whaapys es estructural.
-- ============================================================

alter table public.organizations
  add column if not exists whaapy_postventa_business_id text;

-- UNIQUE parcial (solo filas no-NULL) para que múltiples orgs sin la
-- integración (NULL) no colisionen, mientras se garantiza unicidad del
-- businessId cuando está presente.
create unique index if not exists organizations_whaapy_postventa_business_unique
  on public.organizations (whaapy_postventa_business_id)
  where whaapy_postventa_business_id is not null;

comment on column public.organizations.whaapy_postventa_business_id is
  'businessId del Whaapy de Post-venta (0037). Discriminador de tenant para el endpoint /api/webhooks/whaapy-postventa. Independiente de whaapy_business_id (Venta).';
