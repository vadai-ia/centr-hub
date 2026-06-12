import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import type { UUID } from "@/lib/types/database";

/**
 * Agregación de "última actividad EN LA PLATAFORMA" (M1v2).
 *
 * Fuente única para dos consumidores:
 *   - El motor de reglas: triggers `no_activity` (opp) y
 *     `contact.no_activity` (contacto).
 *   - Mi Día: widget "Clientes silenciosos".
 *
 * Se calcula por AGREGACIÓN de señales reales de plataforma:
 *   último cambio de etapa, última tarea (creada/completada), última
 *   nota / actividad, última orden (creada/pagada en Shopify), última
 *   reasignación manual. NUNCA desde el último mensaje de Whaapy
 *   (`contacts.last_whaapy_activity_at`) — los mensajes no se sincronizan
 *   y "estancada en la plataforma" es lo operativamente útil (CLAUDE.md +
 *   prompt M1v2). El widget detecta oportunidades sin acción reciente.
 *
 * DEBE invocarse dentro de `withTenantContext` (usa getTenantScopedClient).
 */

const ROW_CAP = 20000;

function maxIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function bump(map: Map<UUID, string | null>, key: UUID | null, ts: string | null): void {
  if (!key || !ts) return;
  map.set(key, maxIso(map.get(key) ?? null, ts));
}

/**
 * Última actividad de plataforma por oportunidad. Devuelve un Map con
 * TODOS los ids pedidos (los sin señal quedan en `null`).
 */
export async function lastPlatformActivityForOpportunities(
  opportunityIds: UUID[],
): Promise<Map<UUID, string | null>> {
  const out = new Map<UUID, string | null>();
  for (const id of opportunityIds) out.set(id, null);
  if (opportunityIds.length === 0) return out;

  const { supabase, organizationId } = getTenantScopedClient();
  const ids = opportunityIds.slice(0, ROW_CAP);

  const [stages, tasks, acts] = await Promise.all([
    supabase
      .from("opportunity_stage_history")
      .select("opportunity_id, changed_at")
      .eq("organization_id", organizationId)
      .in("opportunity_id", ids)
      .limit(ROW_CAP),
    supabase
      .from("tasks")
      .select("opportunity_id, created_at, completed_at")
      .eq("organization_id", organizationId)
      .in("opportunity_id", ids)
      .limit(ROW_CAP),
    supabase
      .from("activities")
      .select("opportunity_id, created_at")
      .eq("organization_id", organizationId)
      .in("opportunity_id", ids)
      .limit(ROW_CAP),
  ]);
  if (stages.error) throw stages.error;
  if (tasks.error) throw tasks.error;
  if (acts.error) throw acts.error;

  for (const r of (stages.data ?? []) as Array<{ opportunity_id: UUID | null; changed_at: string }>) {
    bump(out, r.opportunity_id, r.changed_at);
  }
  for (const r of (tasks.data ?? []) as Array<{
    opportunity_id: UUID | null;
    created_at: string;
    completed_at: string | null;
  }>) {
    bump(out, r.opportunity_id, r.created_at);
    bump(out, r.opportunity_id, r.completed_at);
  }
  for (const r of (acts.data ?? []) as Array<{ opportunity_id: UUID | null; created_at: string }>) {
    bump(out, r.opportunity_id, r.created_at);
  }
  return out;
}

/**
 * Última actividad de plataforma por contacto. Agrega señales del propio
 * contacto y de SUS oportunidades. Devuelve un Map con todos los ids
 * pedidos (sin señal → `null`).
 */
export async function lastPlatformActivityForContacts(
  contactIds: UUID[],
): Promise<Map<UUID, string | null>> {
  const out = new Map<UUID, string | null>();
  for (const id of contactIds) out.set(id, null);
  if (contactIds.length === 0) return out;

  const { supabase, organizationId } = getTenantScopedClient();
  const ids = contactIds.slice(0, ROW_CAP);

  // Mapa opp → contacto (para imputar señales que cuelgan de la opp).
  const oppsRes = await supabase
    .from("opportunities")
    .select("id, contact_id")
    .eq("organization_id", organizationId)
    .in("contact_id", ids)
    .limit(ROW_CAP);
  if (oppsRes.error) throw oppsRes.error;
  const oppToContact = new Map<UUID, UUID>();
  for (const r of (oppsRes.data ?? []) as Array<{ id: UUID; contact_id: UUID }>) {
    oppToContact.set(r.id, r.contact_id);
  }
  const oppIds = Array.from(oppToContact.keys());

  const [tasks, acts, orders] = await Promise.all([
    supabase
      .from("tasks")
      .select("contact_id, opportunity_id, created_at, completed_at")
      .eq("organization_id", organizationId)
      .in("contact_id", ids)
      .limit(ROW_CAP),
    supabase
      .from("activities")
      .select("contact_id, opportunity_id, created_at")
      .eq("organization_id", organizationId)
      .in("contact_id", ids)
      .limit(ROW_CAP),
    supabase
      .from("orders")
      .select("contact_id, paid_at, shopify_created_at, created_at")
      .eq("organization_id", organizationId)
      .in("contact_id", ids)
      .limit(ROW_CAP),
  ]);
  if (tasks.error) throw tasks.error;
  if (acts.error) throw acts.error;
  if (orders.error) throw orders.error;

  for (const r of (tasks.data ?? []) as Array<{
    contact_id: UUID | null;
    created_at: string;
    completed_at: string | null;
  }>) {
    bump(out, r.contact_id, r.created_at);
    bump(out, r.contact_id, r.completed_at);
  }
  for (const r of (acts.data ?? []) as Array<{ contact_id: UUID | null; created_at: string }>) {
    bump(out, r.contact_id, r.created_at);
  }
  for (const r of (orders.data ?? []) as Array<{
    contact_id: UUID | null;
    paid_at: string | null;
    shopify_created_at: string | null;
    created_at: string;
  }>) {
    bump(out, r.contact_id, r.paid_at);
    bump(out, r.contact_id, r.shopify_created_at);
    bump(out, r.contact_id, r.created_at);
  }

  // Señales que cuelgan de la oportunidad: cambios de etapa + reasignación
  // manual. Se imputan al contacto dueño de la opp.
  if (oppIds.length > 0) {
    const cappedOppIds = oppIds.slice(0, ROW_CAP);
    const [stages, reassigns] = await Promise.all([
      supabase
        .from("opportunity_stage_history")
        .select("opportunity_id, changed_at")
        .eq("organization_id", organizationId)
        .in("opportunity_id", cappedOppIds)
        .limit(ROW_CAP),
      supabase
        .from("audit_log")
        .select("entity_id, created_at")
        .eq("organization_id", organizationId)
        .eq("entity_type", "opportunity")
        .eq("event_type", "opportunity_reassigned")
        .not("actor_user_id", "is", null)
        .in("entity_id", cappedOppIds)
        .limit(ROW_CAP),
    ]);
    if (stages.error) throw stages.error;
    if (reassigns.error) throw reassigns.error;

    for (const r of (stages.data ?? []) as Array<{ opportunity_id: UUID; changed_at: string }>) {
      bump(out, oppToContact.get(r.opportunity_id) ?? null, r.changed_at);
    }
    for (const r of (reassigns.data ?? []) as Array<{ entity_id: UUID | null; created_at: string }>) {
      if (r.entity_id) bump(out, oppToContact.get(r.entity_id) ?? null, r.created_at);
    }
  }

  return out;
}
