-- ============================================================
-- Outbound · 0043 — Handoff Outbound → Venta (flip in-place atómico)
-- ============================================================
-- Fase 3: la entrega al vendedor. Cuando el SDR califica una oportunidad de
-- Outbound, la ENTREGA a un vendedor. Es el PRIMER movimiento cross-funnel
-- in-place del sistema (todo lo demás crea hija; ver trigger_f1_to_f2).
--
-- La MISMA fila de opportunities cambia funnel 'outbound' → 'venta', aterriza
-- en la etapa Venta "Contacto calificado", toma el asesor elegido, CONSERVA
-- is_outbound (marca permanente) y parent_opportunity_id = NULL (la constraint
-- opportunities_parent_funnel_check ya admite venta ⇒ parent NULL, y outbound
-- ⇒ parent NULL desde 0040, así que el flip es legal en ambos lados).
--
-- Atomicidad por RPC (patrón trigger_f1_to_f2): lock + validaciones + UPDATE +
-- INSERT de historial en un solo cuerpo SIN bloque EXCEPTION → Postgres
-- revierte TODO si algo falla. NO se emula en app (el flip toca un invariante
-- estructural — funnel — y no puede quedar a medias).
--
-- Idempotencia: el guard funnel='outbound' hace que una segunda llamada (doble
-- click) devuelva 'skipped' sin efectos.
--
-- Este migración agrega además:
--   (b) el valor 'outbound_handoff' al CHECK de opportunity_stage_history.context
--       (traza distinta de 'manual' para auditoría/analítica del handoff).
--   (c) la columna opportunities.overridden_tag_advisor_id: cuando un Draft
--       Order posterior trae un asesor DISTINTO por su tag, se CONSERVA el
--       asesor de la entrega (handoff gana) y se guarda aquí el asesor que el
--       tag de Shopify intentó asignar, para MOSTRAR una advertencia. NULL =
--       sin conflicto. La reasignación manual lo limpia. La asignación sigue
--       siendo editable siempre.
-- ============================================================


-- ------------------------------------------------------------
-- (b) Nuevo context 'outbound_handoff' en el historial de etapas
-- ------------------------------------------------------------
alter table public.opportunity_stage_history
  drop constraint if exists opportunity_stage_history_context_check;
alter table public.opportunity_stage_history
  add constraint opportunity_stage_history_context_check
  check (context in (
    'manual', 'webhook', 'automation', 'trigger_f1_f2', 'seed', 'backfill',
    'outbound_handoff'
  ));


-- ------------------------------------------------------------
-- (c) Columna de conflicto de asesor por tag de Shopify
-- ------------------------------------------------------------
alter table public.opportunities
  add column if not exists overridden_tag_advisor_id uuid
    references public.memberships(id) on delete set null;

comment on column public.opportunities.overridden_tag_advisor_id is
  'Conflicto de asesor (0043): un tag de Shopify (draft/orden) intentó asignar '
  'ESTE asesor pero se conservó el asesor de la entrega Outbound (handoff gana). '
  'NULL = sin conflicto. La reasignación manual lo limpia. Solo informativo — '
  'la asignación real vive en assigned_advisor_id y es editable siempre.';


-- ------------------------------------------------------------
-- (a) RPC del handoff — flip in-place atómico
-- ------------------------------------------------------------
-- ⚠ CONTRATO DE INVARIANTES (guard estático en
--   tests/outbound-handoff-rpc-contract.test.ts):
--   INV-1 (flip, no hija): NO hay INSERT into opportunities — es un UPDATE de
--          la MISMA fila (funnel/stage/advisor). Nunca crea una fila nueva.
--   INV-2 (marca): NO toca is_outbound (la marca permanente sobrevive el flip).
--   INV-3 (asesor): setea assigned_advisor_id = p_advisor.
--   INV-4 (destino): resuelve la etapa Venta "Contacto calificado" por nombre.
--   INV-5 (guard): valida funnel='outbound' (idempotencia + no reusar en Venta).
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
    'target_stage_id', v_target_stage.id,
    'advisor_membership_id', p_advisor_membership_id);
end;
$$;

revoke execute on function public.handoff_outbound_opportunity(uuid, uuid)
  from public, anon, authenticated;
grant  execute on function public.handoff_outbound_opportunity(uuid, uuid)
  to service_role;
