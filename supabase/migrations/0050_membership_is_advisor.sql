-- ============================================================
-- Usuarios · 0050 — La ranura de ASESOR se separa del ROL
-- ============================================================
-- Hasta ahora "ser asesor" (dueño de oportunidades, contactos y órdenes) y
-- "tener el rol vendedor" eran el MISMO hecho: todo el sistema listaba
-- asesores con `role = 'vendedor'` (invariante de 0039). El modelo asumía que
-- el rol es el puesto ÚNICO de la persona.
--
-- Ese supuesto se rompe con el primer ascenso real: una vendedora con cartera
-- viva pasa a admin/líder y SIGUE vendiendo. Al cambiarle el rol,
-- `role <> 'vendedor'` la sacó en silencio de:
--   - el desglose por vendedor del Dashboard y sus metas,
--   - el selector de asesor (pipeline, contactos, detalle de oportunidad),
--   - el mapeo de tags de Shopify → sus ventas nuevas dejan de atribuirse,
--   - el mapeo de agentes de Whaapy y el round-robin de leads.
-- Sus datos NUNCA se perdieron (las FK cuelgan de `membership.id`, que no
-- cambia), pero quedó invisible como asesora. Mismo caso para el rol que
-- cotiza sin ser vendedor de planta (dirección/gerencia).
--
-- La corrección es un eje propio, `memberships.is_advisor`, que responde
-- "¿opera cartera comercial?" con independencia del rol (que responde "¿qué
-- ve y qué alcanza?"). Espeja el patrón de `in_lead_rotation` (0045) y de la
-- ranura de Customer Success (0047): un flag ortogonal, gestionado por admin,
-- que no toca la atribución existente.
--
-- INVARIANTES:
--   INV-1  vendedor ⇒ asesor. El rol 'vendedor' SIEMPRE tiene is_advisor
--          true (lo fuerza el trigger). No es un toggle para vendedores.
--   INV-2  salir de 'vendedor' NO apaga la ranura. Es el caso del ascenso:
--          la persona conserva su cartera. Solo el admin la apaga a mano.
--   INV-3  ningún otro rol la enciende solo. Un Customer Success, un SDR o
--          un admin nacen con is_advisor = false; encenderla es una acción
--          explícita del admin (0047 sigue intacto: un CS no es asesor por
--          el hecho de ser CS).
--   INV-4  desenlazar del rol NO mueve datos. Esta migración no toca ni una
--          fila de opportunities/orders/contacts: solo hace visible de nuevo
--          a quien ya era dueño de ellas.

-- ------------------------------------------------------------
-- 1. Columna
-- ------------------------------------------------------------
ALTER TABLE public.memberships
  ADD COLUMN IF NOT EXISTS is_advisor boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.memberships.is_advisor IS
  'Ranura de ASESOR (0050), ortogonal al rol: true = opera cartera comercial '
  '(aparece en el selector de asesor, el mapeo de tags, el mapeo de agentes '
  'de Whaapy, el desglose del dashboard y las metas). El rol vendedor la '
  'fuerza a true (INV-1); salir de vendedor NO la apaga (INV-2); cualquier '
  'otro rol nace en false y el admin la enciende a mano (INV-3).';

-- ------------------------------------------------------------
-- 2. Backfill A — todo vendedor es asesor (sin cambio de comportamiento)
-- ------------------------------------------------------------
UPDATE public.memberships
   SET is_advisor = true
 WHERE role = 'vendedor'
   AND is_advisor = false;

-- ------------------------------------------------------------
-- 3. Backfill B — quien YA tiene cartera es asesor, sea cual sea su rol
-- ------------------------------------------------------------
-- Recupera a quien fue cambiado de rol ANTES de esta migración (el backfill A
-- no lo alcanza: su `role` ya no es 'vendedor'). El criterio es el HECHO, no
-- el puesto: si hay oportunidades, órdenes, contactos, metas o una tag de
-- Shopify apuntando a esa membresía, esa persona operaba cartera.
--
-- Dirigido por datos a propósito: no nombra ninguna organización. Corrige a
-- quien tenga historia en la org donde la tiene, y deja intacta la org donde
-- la persona no ha operado nunca (una membresía recién creada en un tenant
-- nuevo no se enciende sola).
UPDATE public.memberships m
   SET is_advisor = true
 WHERE m.is_advisor = false
   AND (
        EXISTS (SELECT 1 FROM public.opportunities o
                 WHERE o.assigned_advisor_id = m.id)
     OR EXISTS (SELECT 1 FROM public.orders ord
                 WHERE ord.assigned_advisor_id = m.id)
     OR EXISTS (SELECT 1 FROM public.contacts c
                 WHERE c.assigned_advisor_id = m.id)
     OR EXISTS (SELECT 1 FROM public.goals g
                 WHERE g.advisor_membership_id = m.id)
     OR EXISTS (SELECT 1 FROM public.tag_mappings t
                 WHERE t.mapped_membership_id = m.id)
   );

-- ------------------------------------------------------------
-- 4. Trigger — INV-1 e INV-2
-- ------------------------------------------------------------
-- Vive en BD (no en la capa TS) por la misma razón que el trigger de Customer
-- Success de 0047: las membresías nacen por varias vías y una es SQL puro
-- (`bootstrap_organization` siembra el usuario sistema "Histórico" con
-- role='vendedor'). Una sola regla en BD las cubre todas.
CREATE OR REPLACE FUNCTION public.tg_membership_sync_is_advisor()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- INV-1: el rol vendedor SIEMPRE opera cartera. Encender la ranura al
  -- entrar (o permanecer) en el rol es idempotente.
  IF new.role = 'vendedor' THEN
    new.is_advisor := true;
  END IF;

  -- INV-2: NO hay rama que apague la ranura al salir de 'vendedor'. Es
  -- deliberado — es exactamente el ascenso que esta migración corrige. El
  -- admin la apaga desde Admin → Usuarios cuando la persona deja de vender.
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS memberships_sync_is_advisor ON public.memberships;
CREATE TRIGGER memberships_sync_is_advisor
  BEFORE INSERT OR UPDATE OF role ON public.memberships
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_membership_sync_is_advisor();

-- ------------------------------------------------------------
-- 5. Re-CREATE del RPC de handoff Outbound → Venta
-- ------------------------------------------------------------
-- `handoff_outbound_opportunity` (vigente en 0044) valida al asesor destino
-- con `role <> 'vendedor'`. Es la ÚNICA validación de elegibilidad de asesor
-- que vive en SQL, así que sin este re-CREATE la entrega de un lead Outbound
-- a la líder-vendedora fallaría con 'advisor_not_eligible' aunque la UI la
-- ofreciera. Cuerpo idéntico al de 0044 salvo esa condición (INV-1..INV-6
-- intactos — guard: tests/outbound-handoff-rpc-contract.test.ts).
create or replace function public.handoff_outbound_opportunity(
  p_opportunity_id uuid,
  p_advisor_membership_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_opp          public.opportunities%rowtype;
  v_target_stage public.pipeline_stages%rowtype;
  v_advisor      public.memberships%rowtype;
  v_from_stage   uuid;
begin
  -- Lock pesimista: serializa dobles clicks / llamadas concurrentes.
  select * into v_opp
    from public.opportunities
   where id = p_opportunity_id
   for update;
  if not found then
    return jsonb_build_object('status', 'skipped', 'reason', 'opportunity_not_found');
  end if;

  -- INV-5: solo se entrega una opp de Outbound activa. Segunda llamada
  -- (ya flipeada a venta) → skipped idempotente.
  if v_opp.funnel <> 'outbound' then
    return jsonb_build_object('status', 'skipped', 'reason', 'not_outbound');
  end if;
  if v_opp.cancelled_at is not null then
    return jsonb_build_object('status', 'skipped', 'reason', 'cancelled');
  end if;

  -- Validar asesor: ranura de ASESOR activa en la MISMA organización (0050 —
  -- ya no el rol: un admin/líder que conserva cartera es asesor elegible).
  -- Defensa en profundidad — la action ya valida vía listActiveRealVendors.
  select * into v_advisor
    from public.memberships
   where id = p_advisor_membership_id
     and organization_id = v_opp.organization_id;
  if not found then
    return jsonb_build_object('status', 'error', 'reason', 'advisor_not_found');
  end if;
  if v_advisor.is_active is not true or v_advisor.is_advisor is not true then
    return jsonb_build_object('status', 'error', 'reason', 'advisor_not_eligible');
  end if;

  -- INV-4: etapa destino = Venta "Contacto calificado" (nombre canónico —
  -- VENTA_AUTOMATION_STAGE_NAMES.calificado). Si el admin la renombró, error
  -- accionable (la action lo traduce a mensaje).
  select * into v_target_stage
    from public.pipeline_stages
   where organization_id = v_opp.organization_id
     and funnel = 'venta'
     and name = 'Contacto calificado'
     and is_active = true
   limit 1;
  if not found then
    return jsonb_build_object('status', 'error', 'reason', 'target_stage_not_found');
  end if;

  v_from_stage := v_opp.stage_id;

  -- INV-1/2/3: FLIP in-place de la MISMA fila. funnel→venta, etapa→calificado,
  -- asesor→elegido. La marca y el parent (NULL) NO se tocan (fuera del SET →
  -- sobreviven). Limpia cualquier conflicto de tag previo (arranca limpio).
  update public.opportunities
     set funnel                    = 'venta',
         stage_id                  = v_target_stage.id,
         assigned_advisor_id       = p_advisor_membership_id,
         overridden_tag_advisor_id = null,
         last_modified_at          = now(),
         last_modified_source      = 'platform'
   where id = v_opp.id;

  -- INV-6: el CONTACTO adopta el vendedor como dueño (misma transacción). Esto
  -- alimenta el agente en Whaapy (Track 2), el tag en Shopify y el data-scope
  -- del vendedor. La entrega TRANSFIERE la propiedad del contacto.
  update public.contacts
     set assigned_advisor_id  = p_advisor_membership_id,
         last_modified_at     = now(),
         last_modified_source = 'platform'
   where id = v_opp.contact_id;

  -- Historial: transición de la etapa Outbound a la Venta calificado, con
  -- context distintivo del handoff. (El funnel no vive en el historial; solo
  -- se registran las etapas de origen y destino.)
  insert into public.opportunity_stage_history
    (organization_id, opportunity_id, from_stage_id, to_stage_id,
     changed_by_user_id, context)
  values
    (v_opp.organization_id, v_opp.id, v_from_stage, v_target_stage.id,
     null, 'outbound_handoff');

  return jsonb_build_object(
    'status', 'handed_off',
    'opportunity_id', v_opp.id,
    'contact_id', v_opp.contact_id,
    'target_stage_id', v_target_stage.id,
    'advisor_membership_id', p_advisor_membership_id);
end;
$$;

revoke execute on function public.handoff_outbound_opportunity(uuid, uuid)
  from public, anon, authenticated;
grant  execute on function public.handoff_outbound_opportunity(uuid, uuid)
  to service_role;
