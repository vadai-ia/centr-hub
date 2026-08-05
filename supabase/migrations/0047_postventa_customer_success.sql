-- ============================================================
-- Post-venta · 0047 — Customer Success como segunda ranura de asignación
-- ============================================================
-- Hasta aquí una oportunidad tenía UNA sola ranura de persona
-- (`assigned_advisor_id`) y la asignabilidad estaba cableada al
-- `role='vendedor'` (invariante de 0039: "solo los vendedores son
-- asesores"). Post-venta necesita algo distinto: el vendedor que cerró la
-- venta SIGUE siendo el asesor de la opp hija, y ADEMÁS entra un Customer
-- Success que atiende el caso.
--
-- Modelo: segunda ranura INDEPENDIENTE (`customer_success_membership_id`).
--   * NO reemplaza ni pisa nunca a `assigned_advisor_id` — son ejes
--     distintos. Un contacto puede tener vendedor en Venta y CS en Post-venta.
--   * Al ser UNA columna, asignar otro CS reemplaza al anterior por
--     construcción: no hay forma de tener dos CS a la vez.
--   * Semántica EXCLUSIVA de Post-venta. Venta y Outbound la dejan en NULL;
--     el trigger de abajo solo la rellena para funnel='post_venta'.
--
-- El invariante de 0039 queda intacto: `listActiveRealVendors` (selector de
-- asesor, mapeo de tags, round-robin, Whaapy) sigue filtrando role='vendedor'
-- y un Customer Success NUNCA entra ahí. La nueva ranura tiene su propio
-- listado, cableado al rol `customer-success`.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Columna — segunda ranura de asignación
-- ------------------------------------------------------------
-- ON DELETE SET NULL: si el membership del CS desaparece, la opp queda sin
-- CS (nunca se borra la oportunidad). Mismo criterio que assigned_advisor_id.
ALTER TABLE public.opportunities
  ADD COLUMN IF NOT EXISTS customer_success_membership_id uuid
    REFERENCES public.memberships(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.opportunities.customer_success_membership_id IS
  'Customer Success asignado (0047). Segunda ranura INDEPENDIENTE de '
  'assigned_advisor_id: el asesor de venta se conserva intacto y el CS se '
  'suma. Una sola columna → un solo CS por oportunidad (asignar otro '
  'reemplaza). Solo semántica de Post-venta; NULL en Venta y Outbound.';

-- Filtro del pipeline "ver solo las opps de este Customer Success".
CREATE INDEX IF NOT EXISTS opportunities_org_customer_success_idx
  ON public.opportunities (organization_id, customer_success_membership_id)
  WHERE customer_success_membership_id IS NOT NULL;

-- ------------------------------------------------------------
-- 2) Resolución del CS por defecto de la organización
-- ------------------------------------------------------------
-- Ancla ESTABLE en `organizations.config.postventa.customer_success_membership_id`
-- — mismo patrón que `postventa.resolver_user_id` (seed-customer-success).
-- Editar nombre/email de la persona NO cambia el membership_id → la
-- asignación automática nunca se rompe. Para cambiar de persona se reescribe
-- el ancla (un UPDATE), sin tocar código.
--
-- Fallback defensivo: si el ancla falta o quedó apuntando a un membership
-- que ya no califica (borrado, inactivo, o cambiado de rol), se usa el
-- Customer Success activo más antiguo de la org. Si la org no tiene ninguno
-- (caso Rustr, que no usa el rol), devuelve NULL y la opp nace sin CS — NO
-- se inventa un asesor de otro rol.
CREATE OR REPLACE FUNCTION public.default_customer_success_membership_id(
  p_organization_id uuid
) RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_anchor uuid;
  v_result uuid;
BEGIN
  IF p_organization_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT nullif(o.config #>> '{postventa,customer_success_membership_id}', '')::uuid
    INTO v_anchor
  FROM public.organizations o
  WHERE o.id = p_organization_id;

  -- El ancla vale solo si sigue calificando HOY.
  IF v_anchor IS NOT NULL THEN
    SELECT m.id INTO v_result
    FROM public.memberships m
    WHERE m.id = v_anchor
      AND m.organization_id = p_organization_id
      AND m.is_active
      AND m.role = 'customer-success';
    IF v_result IS NOT NULL THEN
      RETURN v_result;
    END IF;
  END IF;

  -- Fallback: el Customer Success activo más antiguo de la org.
  SELECT m.id INTO v_result
  FROM public.memberships m
  JOIN public.user_profiles p ON p.id = m.user_id
  WHERE m.organization_id = p_organization_id
    AND m.is_active
    AND m.role = 'customer-success'
    AND NOT p.is_system_user
  ORDER BY m.created_at ASC
  LIMIT 1;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.default_customer_success_membership_id(uuid) IS
  'Customer Success por defecto de la org (0047). Precedencia: ancla en '
  'config.postventa.customer_success_membership_id (validada contra un '
  'membership activo con role=customer-success) → CS activo más antiguo → '
  'NULL. Consumida por el trigger de default y por la capa de servicio.';

-- No es una RPC pública: la invocan el trigger (como definer) y la capa de
-- servicio (service_role). Un `authenticated` no debe poder sondear el CS de
-- otra organización pasándole un org_id ajeno.
REVOKE ALL ON FUNCTION public.default_customer_success_membership_id(uuid) FROM public;
REVOKE ALL ON FUNCTION public.default_customer_success_membership_id(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.default_customer_success_membership_id(uuid)
  TO service_role;

-- ------------------------------------------------------------
-- 3) Trigger — toda opp de Post-venta nace con Customer Success
-- ------------------------------------------------------------
-- Vive en BD (y no en la capa de servicio) A PROPÓSITO: las opps de
-- Post-venta nacen por CUATRO vías distintas y una de ellas es SQL puro.
--   (a) trigger F1→F2 al pagar la orden (0027)  ← SQL, no pasa por TS
--   (b) webhook de Whaapy Post-venta            ← TS
--   (c) reapertura de caso                      ← TS
--   (d) backfill                                ← TS
-- Un BEFORE INSERT sobre `opportunities` cubre las cuatro con una sola
-- regla; cualquier vía futura queda cubierta automáticamente.
--
-- Solo rellena cuando viene NULL: un CS explícito (asignación manual, o el
-- que la reapertura hereda de la opp original) NUNCA se pisa.
CREATE OR REPLACE FUNCTION public.tg_opportunity_default_customer_success()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.funnel = 'post_venta' AND NEW.customer_success_membership_id IS NULL THEN
    NEW.customer_success_membership_id :=
      public.default_customer_success_membership_id(NEW.organization_id);
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.tg_opportunity_default_customer_success() IS
  'Rellena customer_success_membership_id con el CS por defecto de la org '
  'en toda opp de Post-venta que nazca (o que pase) a funnel=post_venta '
  'sin CS explícito (0047). NUNCA pisa un CS ya asignado.';

DROP TRIGGER IF EXISTS opportunities_default_customer_success
  ON public.opportunities;

-- INSERT: toda opp nueva de Post-venta. UPDATE OF funnel: red de seguridad
-- por si alguna vez una opp migrara de funnel (hoy el funnel es inmutable).
CREATE TRIGGER opportunities_default_customer_success
  BEFORE INSERT OR UPDATE OF funnel ON public.opportunities
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_opportunity_default_customer_success();

-- ------------------------------------------------------------
-- 4) Sembrar el ancla — el CS activo más antiguo de cada org
-- ------------------------------------------------------------
-- Idempotente y no destructivo: solo escribe donde el ancla NO existe. Una
-- org sin rol `customer-success` (Rustr) no recibe nada.
--
-- Se reescribe el objeto `postventa` ENTERO como "lo que ya había + la key
-- nueva": `jsonb_set` con create_missing NO crea niveles intermedios, así
-- que una org sin `postventa` previo quedaría sin ancla; y un `||` sobre un
-- literal borraría `resolver_user_id` en las que sí lo tienen. Esta forma
-- cubre ambos casos preservando las keys existentes.
UPDATE public.organizations o
SET config = jsonb_set(
      coalesce(o.config, '{}'::jsonb),
      '{postventa}',
      coalesce(o.config -> 'postventa', '{}'::jsonb)
        || jsonb_build_object(
             'customer_success_membership_id', cs.membership_id::text
           ),
      true
    )
FROM (
  SELECT DISTINCT ON (m.organization_id)
         m.organization_id, m.id AS membership_id
  FROM public.memberships m
  JOIN public.user_profiles p ON p.id = m.user_id
  WHERE m.is_active
    AND m.role = 'customer-success'
    AND NOT p.is_system_user
  ORDER BY m.organization_id, m.created_at ASC
) cs
WHERE cs.organization_id = o.id
  AND nullif(o.config #>> '{postventa,customer_success_membership_id}', '') IS NULL;

-- ------------------------------------------------------------
-- 5) Backfill — las opps de Post-venta que YA existen
-- ------------------------------------------------------------
-- Requisito explícito del operador: el CS debe estar asignado en TODAS las
-- oportunidades que estén en Post-venta, no solo en las nuevas. Se rellena
-- únicamente donde está NULL (nunca pisa una asignación existente) y NO se
-- toca `assigned_advisor_id` ni `last_modified_at` (no es un cambio de
-- negocio del que dependa LWW; es el relleno de una columna nueva).
UPDATE public.opportunities o
SET customer_success_membership_id =
      public.default_customer_success_membership_id(o.organization_id)
WHERE o.funnel = 'post_venta'
  AND o.customer_success_membership_id IS NULL
  AND public.default_customer_success_membership_id(o.organization_id) IS NOT NULL;
