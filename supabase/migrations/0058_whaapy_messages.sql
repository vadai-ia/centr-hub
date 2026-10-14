-- ============================================================
-- 0058 — Tiempo de respuesta del asesor (mensajes de Whaapy)
-- ============================================================
-- Lo que se pidió: "¿cuánto tarda cada comercial en contestar?". Hasta hoy
-- la plataforma medía el tiempo al primer MOVIMIENTO de la tarjeta en el CRM
-- (`lead-timings`), no a la RESPUESTA real: la conversación vive en el iframe
-- de Whaapy y nunca se descargaba. Si el asesor contestó rápido por WhatsApp
-- y no tocó la tarjeta, ahí no se veía.
--
-- QUÉ SE GUARDA Y QUÉ NO — el contenido del mensaje NO se guarda. La métrica
-- necesita CUÁNDO y EN QUÉ SENTIDO, nada más; el texto es PII que entraría a
-- una tabla nueva sin ninguna lectura que lo justifique. Es la misma regla
-- que "NO loguear payloads completos" de los webhooks.
--
-- `sent_by_ai` NO es un adorno: el agente de IA de Whaapy contesta en
-- segundos, y sin distinguirlo TODOS los asesores marcarían respuesta
-- instantánea y la métrica sería ruido con forma de número.
--
-- `advisor_membership_id` se congela AL INGESTAR, no se resuelve después:
-- lo que se quiere saber es quién contestó, y la asignación del contacto
-- puede cambiar de dueño mañana. Resolverlo por join al consultar reportaría
-- las respuestas de ayer a cargo del asesor de hoy.
-- ============================================================

create table if not exists public.whaapy_messages (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations(id) on delete cascade,
  -- Id del mensaje en Whaapy. Es la llave de idempotencia: un reintento del
  -- webhook no puede duplicar la fila y falsear el conteo.
  whaapy_message_id     text not null,
  conversation_id       text not null,
  -- Puede faltar: `message.sent` trae el teléfono destino, no el contacto, y
  -- el contacto podría no existir aún en el maestro. La métrica se calcula
  -- por conversación, así que no lo necesita.
  contact_id            uuid references public.contacts(id) on delete set null,
  direction             text not null check (direction in ('inbound', 'outbound')),
  -- Solo aplica a 'outbound'. Un mensaje del agente de IA NO cierra el turno.
  sent_by_ai            boolean not null default false,
  -- Quién tenía el contacto asignado EN EL MOMENTO del mensaje. Snapshot.
  advisor_membership_id uuid references public.memberships(id) on delete set null,
  occurred_at           timestamptz not null,
  created_at            timestamptz not null default now()
);

comment on table public.whaapy_messages is
  'Metadata de mensajes de WhatsApp (0058) para medir el tiempo de respuesta '
  'del asesor. SIN contenido del mensaje: la métrica solo necesita cuándo y '
  'en qué sentido, y el texto seria PII sin lectura que la justifique.';
comment on column public.whaapy_messages.sent_by_ai is
  'El agente de IA de Whaapy contesta en segundos. Sin esta bandera todos los '
  'asesores marcarian respuesta instantanea.';
comment on column public.whaapy_messages.advisor_membership_id is
  'Congelado al ingestar. message.sent no dice que humano escribio, asi que '
  'sale del asesor asignado al contacto en ese momento.';

-- Idempotencia del webhook. Por organización porque el id es de Whaapy y hay
-- dos instancias (Venta y Post-venta) que podrían reusar un espacio de ids.
create unique index if not exists whaapy_messages_org_message_uq
  on public.whaapy_messages (organization_id, whaapy_message_id);

-- Lectura de emparejamiento: los mensajes de una conversación en orden.
create index if not exists whaapy_messages_conversation_idx
  on public.whaapy_messages (organization_id, conversation_id, occurred_at);

-- Lectura del dashboard: todo lo de la organización en una ventana de tiempo.
create index if not exists whaapy_messages_org_occurred_idx
  on public.whaapy_messages (organization_id, occurred_at desc);

-- RLS: las 4 tenant policies estándar (macro de 0009 / 0031 / 0038 / 0057).
alter table public.whaapy_messages enable row level security;

create policy whaapy_messages_tenant_select on public.whaapy_messages
  for select using (organization_id = public.current_organization_id());

create policy whaapy_messages_tenant_insert on public.whaapy_messages
  for insert with check (organization_id = public.current_organization_id());

create policy whaapy_messages_tenant_update on public.whaapy_messages
  for update using (organization_id = public.current_organization_id())
  with check (organization_id = public.current_organization_id());

create policy whaapy_messages_tenant_delete on public.whaapy_messages
  for delete using (organization_id = public.current_organization_id());


-- ------------------------------------------------------------
-- merge_lead_contact_into_client — re-CREADO desde la VIGENTE (0054)
-- ------------------------------------------------------------
-- `whaapy_messages` referencia `contacts`, así que la fusión de un lead
-- duplicado en su cliente TIENE que re-apuntarla: si no, los mensajes de la
-- persona se quedarían colgando del contacto que se borra y su tiempo de
-- respuesta desaparecería del reporte. (La FK es ON DELETE SET NULL, así que
-- el borrado no reventaría — simplemente perdería la liga en silencio, que
-- es peor.)
--
-- Único cambio respecto de 0054: el UPDATE de `whaapy_messages` y su conteo
-- en el reporte de dry-run. Lo exige el guard
-- `tests/contact-lead-merge-sql-contract.test.ts`, que descubre las tablas
-- leyendo las migraciones.
create or replace function public.merge_lead_contact_into_client(
  p_lead_id uuid,
  p_client_id uuid,
  p_dry_run boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead       public.contacts%rowtype;
  v_client     public.contacts%rowtype;
  v_same_phone integer;
  v_orders     integer;
  v_moved      jsonb;
  v_snapshot   jsonb;
  v_whaapy     text;
begin
  if p_lead_id = p_client_id then
    return jsonb_build_object('status', 'skipped', 'reason', 'same_contact');
  end if;

  -- Lock de ambas filas en orden estable (por id): dos fusiones concurrentes
  -- sobre los mismos contactos se serializan en vez de bloquearse mutuamente.
  perform 1
     from public.contacts
    where id in (p_lead_id, p_client_id)
    order by id
      for update;

  select * into v_lead from public.contacts where id = p_lead_id;
  if not found then
    return jsonb_build_object('status', 'skipped', 'reason', 'lead_not_found');
  end if;
  select * into v_client from public.contacts where id = p_client_id;
  if not found then
    return jsonb_build_object('status', 'skipped', 'reason', 'client_not_found');
  end if;

  if v_lead.organization_id <> v_client.organization_id then
    return jsonb_build_object('status', 'skipped', 'reason', 'organization_mismatch');
  end if;
  -- INV-1
  if v_client.shopify_customer_id is null then
    return jsonb_build_object('status', 'skipped', 'reason', 'client_not_a_client');
  end if;
  if v_lead.shopify_customer_id is not null then
    return jsonb_build_object('status', 'skipped', 'reason', 'lead_is_a_client');
  end if;
  if v_lead.anonymized_at is not null or v_client.anonymized_at is not null then
    return jsonb_build_object('status', 'skipped', 'reason', 'anonymized');
  end if;
  -- INV-2
  if v_client.phone is null or v_lead.phone is distinct from v_client.phone then
    return jsonb_build_object('status', 'skipped', 'reason', 'phone_mismatch');
  end if;
  select count(*) into v_same_phone
    from public.contacts
   where organization_id = v_client.organization_id
     and phone = v_client.phone;
  if v_same_phone <> 2 then
    return jsonb_build_object('status', 'skipped', 'reason', 'ambiguous_phone');
  end if;
  -- INV-4
  if v_lead.whaapy_contact_id is not null
     and v_client.whaapy_contact_id is not null
     and v_lead.whaapy_contact_id <> v_client.whaapy_contact_id then
    return jsonb_build_object('status', 'skipped', 'reason', 'whaapy_identity_conflict');
  end if;
  -- INV-3
  select count(*) into v_orders from public.orders where contact_id = v_lead.id;
  if v_orders > 0 then
    return jsonb_build_object('status', 'skipped', 'reason', 'lead_has_orders');
  end if;

  v_moved := jsonb_build_object(
    'opportunities',   (select count(*) from public.opportunities   where contact_id = v_lead.id),
    'orders',          v_orders,
    'rule_executions', (select count(*) from public.rule_executions where contact_id = v_lead.id),
    'activities',      (select count(*) from public.activities      where contact_id = v_lead.id),
    'tasks',           (select count(*) from public.tasks           where contact_id = v_lead.id),
    'notifications',   (select count(*) from public.notifications   where contact_id = v_lead.id),
    'whaapy_messages', (select count(*) from public.whaapy_messages where contact_id = v_lead.id)
  );

  if p_dry_run then
    return jsonb_build_object('status', 'dry_run', 'moved', v_moved);
  end if;

  v_snapshot := to_jsonb(v_lead);

  -- INV-5: todo lo que apunta al lead pasa al cliente.
  update public.opportunities   set contact_id = v_client.id where contact_id = v_lead.id;
  update public.orders          set contact_id = v_client.id where contact_id = v_lead.id;
  update public.rule_executions set contact_id = v_client.id where contact_id = v_lead.id;
  update public.tasks           set contact_id = v_client.id where contact_id = v_lead.id;
  update public.notifications   set contact_id = v_client.id where contact_id = v_lead.id;
  update public.whaapy_messages set contact_id = v_client.id where contact_id = v_lead.id;

  -- activities es inmutable: la bandera se enciende SOLO alrededor de este
  -- update (transaccional: un error revierte también la bandera).
  perform set_config('centr.contact_merge', 'on', true);
  update public.activities      set contact_id = v_client.id where contact_id = v_lead.id;
  perform set_config('centr.contact_merge', 'off', true);

  -- INV-6: liberar el id de Whaapy del lead antes de asignarlo al cliente.
  v_whaapy := v_lead.whaapy_contact_id;
  if v_whaapy is not null then
    update public.contacts set whaapy_contact_id = null where id = v_lead.id;
  end if;

  -- INV-7 (fill-if-null) + INV-8 (sin tocar last_modified_*). En el SET, las
  -- referencias a c.* son los valores ANTERIORES a este update.
  update public.contacts c
     set full_name               = coalesce(c.full_name, v_lead.full_name),
         email                   = coalesce(c.email, v_lead.email),
         address                 = coalesce(c.address, v_lead.address),
         internal_note           = coalesce(c.internal_note, v_lead.internal_note),
         assigned_advisor_id     = coalesce(c.assigned_advisor_id, v_lead.assigned_advisor_id),
         whaapy_contact_id       = coalesce(c.whaapy_contact_id, v_whaapy),
         deleted_in_whaapy       = case
                                     when c.whaapy_contact_id is null and v_whaapy is not null
                                       then v_lead.deleted_in_whaapy
                                     else c.deleted_in_whaapy
                                   end,
         last_whaapy_activity_at = greatest(c.last_whaapy_activity_at, v_lead.last_whaapy_activity_at),
         is_outbound             = c.is_outbound or v_lead.is_outbound,
         missing_phone           = false,
         -- metadata LWW: gana la del cliente; la del lead solo aporta llaves
         -- de campos que el cliente no tenía.
         field_metadata          = v_lead.field_metadata || c.field_metadata
   where c.id = v_client.id;

  -- Al final, cuando ya nada apunta al lead.
  delete from public.contacts where id = v_lead.id;

  return jsonb_build_object(
    'status', 'merged',
    'moved', v_moved,
    'lead_snapshot', v_snapshot
  );
end;
$$;

revoke execute on function public.merge_lead_contact_into_client(uuid, uuid, boolean)
  from public, anon, authenticated;
grant  execute on function public.merge_lead_contact_into_client(uuid, uuid, boolean)
  to service_role;
