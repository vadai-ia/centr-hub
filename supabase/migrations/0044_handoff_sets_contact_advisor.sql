-- ============================================================
-- Outbound · 0044 — Handoff también asigna el asesor al CONTACTO (fix F3 #1)
-- ============================================================
-- El handoff (0043) asignaba el vendedor solo a la OPORTUNIDAD, no al
-- CONTACTO. Pero la identidad de "dueño" del contacto (que dispara: agente en
-- Whaapy vía Track 2, tag de vendedor en Shopify, y el data-scope del vendedor)
-- vive en `contacts.assigned_advisor_id`. Sin esto, tras la entrega el contacto
-- quedaba SIN asignar y no se propagaba nada a Whaapy.
--
-- Re-CREATE de `handoff_outbound_opportunity` (0043) conservando sus 5
-- invariantes + INV-6 nueva: setea `contacts.assigned_advisor_id` = vendedor
-- en la MISMA transacción atómica (el flip de la opp y la asignación del
-- contacto no pueden quedar a medias). La propagación a Whaapy (Track 2,
-- recordWhaapySyncIntent) la dispara el SERVICE tras el RPC (Inngest no vive
-- en SQL) — ver lib/services/outbound-handoff.ts.
--
-- Guard estático: tests/outbound-handoff-rpc-contract.test.ts (INV-6 nueva).
-- ============================================================
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

  -- Validar asesor: vendedor activo de la MISMA organización (defensa en
  -- profundidad — la action ya valida vía listActiveRealVendors).
  select * into v_advisor
    from public.memberships
   where id = p_advisor_membership_id
     and organization_id = v_opp.organization_id;
  if not found then
    return jsonb_build_object('status', 'error', 'reason', 'advisor_not_found');
  end if;
  if v_advisor.is_active is not true or v_advisor.role <> 'vendedor' then
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
