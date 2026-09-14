-- ============================================================
-- Contactos · 0054 — Fusión de un LEAD duplicado dentro de su CLIENTE
-- ============================================================
-- EL PROBLEMA (verificado en los webhooks crudos de los casos reportados):
-- el vendedor crea el cliente en Shopify al vuelo —al cotizar— solo con
-- nombre o correo y le agrega el teléfono minutos después. `customers/create`
-- llega sin teléfono, el identity matching no tiene con qué empatar con el
-- lead que ya existía (WhatsApp o formulario) y nace una SEGUNDA tarjeta.
-- Cuando el teléfono llega por `customers/update`, el contacto ya existe por
-- su `shopify_customer_id` y nadie vuelve a buscar coincidencias.
--
-- LA CORRECCIÓN: el worker de `customers/update`, al ver que el cliente
-- recibió teléfono, decide si hay un lead que fusionar
-- (lib/services/contact-lead-merge.ts) y llama a este RPC, que hace la parte
-- que DEBE ser atómica.
--
-- INVARIANTES DEL RPC (revalidados bajo lock: la decisión en TS pudo quedar
-- vieja entre que se tomó y que se ejecuta):
--   INV-1  solo lead → cliente: el cliente tiene `shopify_customer_id`, el lead
--          no. Dos clientes de Shopify NUNCA se fusionan aquí (un contacto no
--          puede ligarse a dos customers; en Centr varios de esos pares son
--          personas distintas que comparten número).
--   INV-2  mismo teléfono, y EXACTAMENTE dos contactos lo tienen.
--   INV-3  el lead no tiene pedidos.
--   INV-4  sin choque de identidades de Whaapy.
--   INV-5  se mueve TODO lo que apunta al lead antes de borrarlo. Son seis
--          tablas: opportunities y orders (ON DELETE RESTRICT), rule_executions
--          (SET NULL) y activities, tasks, notifications (CASCADE — sin
--          moverlas, el borrado del lead se llevaría su historial).
--   INV-6  el id de Whaapy se libera del lead ANTES de asignarse al cliente:
--          `contacts_org_whaapy_contact_unique` rechazaría tenerlo en dos filas.
--   INV-7  el cliente conserva sus datos; del lead solo se toman los campos
--          que al cliente le faltan (fill-if-null). Nunca se pisa nada.
--   INV-8  NO se marca `last_modified_source = 'platform'`: la defensa
--          anti-bucle (R11 opción B) usa esa marca con ventana de 30 s y
--          descartaría como "eco propio" un webhook legítimo posterior.
--
-- Reversibilidad: el RPC devuelve la foto completa del lead (`lead_snapshot`)
-- y el servicio la guarda en el audit `contact_lead_merged_into_client`.

-- ------------------------------------------------------------
-- 1. activities: sigue inmutable, con UNA excepción acotada
-- ------------------------------------------------------------
-- `activities` usaba `tg_block_mutation` (0004): bloquea todo UPDATE y DELETE.
-- Eso impide fusionar de dos formas: no se puede re-apuntar el historial del
-- lead al cliente, y borrar el lead falla porque su cascada sobre activities
-- también dispara el bloqueo.
--
-- Mismo patrón que 0025 con `opportunity_stage_history`: se reemplaza el
-- bloqueo genérico por una guarda que conserva la inmutabilidad del CONTENIDO
-- (tipo, descripción, payload, autor, fecha) y permite únicamente re-apuntar
-- `contact_id`, y solo mientras una fusión tiene encendida la bandera
-- transaccional `centr.contact_merge`. DELETE sigue bloqueado siempre.
create or replace function public.tg_activities_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'immutable_table: activities no acepta DELETE (audit trail)'
      using errcode = 'P0001';
  end if;

  if coalesce(current_setting('centr.contact_merge', true), '') <> 'on' then
    raise exception 'immutable_table: activities no acepta UPDATE (audit trail)'
      using errcode = 'P0001';
  end if;

  -- Durante una fusión, lo ÚNICO que puede cambiar es contact_id.
  if (OLD.id, OLD.organization_id, OLD.opportunity_id, OLD.activity_type,
      OLD.description, OLD.payload, OLD.triggered_by_user_id, OLD.created_at)
     is distinct from
     (NEW.id, NEW.organization_id, NEW.opportunity_id, NEW.activity_type,
      NEW.description, NEW.payload, NEW.triggered_by_user_id, NEW.created_at)
  then
    raise exception 'immutable_table: activities solo permite re-apuntar contact_id durante una fusión (audit trail)'
      using errcode = 'P0001';
  end if;

  return NEW;
end;
$$;

drop trigger if exists activities_no_update on public.activities;
drop trigger if exists activities_guard on public.activities;

create trigger activities_guard
  before update or delete on public.activities
  for each row execute function public.tg_activities_guard();

-- ------------------------------------------------------------
-- 2. RPC de fusión
-- ------------------------------------------------------------
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
    'notifications',   (select count(*) from public.notifications   where contact_id = v_lead.id)
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
