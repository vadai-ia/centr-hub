import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import { getContactById } from "@/lib/db/contacts";
import { listOpportunities } from "@/lib/db/opportunities";
import { recordAuditEvent } from "@/lib/db/operational";
import { absorbInitialStageOpportunities } from "@/lib/services/opportunity-absorption";
import type { ContactRow, Json, UUID } from "@/lib/types/database";

/**
 * Fusión de un LEAD duplicado dentro de su CLIENTE de Shopify (migración 0054).
 *
 * EL PROBLEMA: el vendedor crea el cliente en Shopify al vuelo —al cotizar—
 * solo con nombre o correo, y le agrega el teléfono minutos después. Al
 * crearse no hay con qué empatarlo con el lead que ya existía (el de WhatsApp
 * o el del formulario), así que nace una SEGUNDA tarjeta. Cuando el teléfono
 * llega por `customers/update`, el contacto ya existe por su
 * `shopify_customer_id` y nadie vuelve a buscar coincidencias: quedan dos
 * tarjetas con el mismo número para siempre. Verificado en los webhooks
 * crudos de los casos reportados.
 *
 * QUÉ SE FUSIONA — y deliberadamente NADA MÁS:
 *   - el CLIENTE tiene identidad de Shopify y teléfono;
 *   - existe EXACTAMENTE UN otro contacto con ese teléfono, y es un LEAD
 *     (sin Shopify);
 *   - sus identidades no chocan (no traen dos Whaapy distintos);
 *   - el lead no tiene pedidos (lo revalida el RPC, bajo lock);
 *   - los nombres son compatibles (ver `namesCompatible`).
 *
 * NO se fusionan dos CLIENTES de Shopify con el mismo teléfono: un contacto
 * solo puede ligarse a un `shopify_customer_id`, y en Centr varios de esos
 * pares son personas distintas que comparten número (familia, negocio). Esos
 * se unen primero en Shopify.
 *
 * La mecánica atómica (mover las 6 tablas que apuntan al contacto, liberar el
 * id de Whaapy antes de reasignarlo, borrar el lead) vive en el RPC
 * `merge_lead_contact_into_client`. Aquí se decide SI fusionar y se hace lo que
 * no es SQL: audit con la foto completa del lead (reversibilidad) y archivar su
 * "Lead nuevo" frente a la cotización del cliente.
 */

export type LeadMergeTrigger = "customers_update_phone" | "corrective_script";

export type MergeSkipReason =
  | "not_a_client"
  | "no_phone"
  | "client_anonymized"
  | "no_lead_with_phone"
  | "ambiguous_phone"
  | "other_is_client"
  | "lead_anonymized"
  | "whaapy_identity_conflict"
  | "name_mismatch";

export type LeadMergeDecision =
  | { action: "merge"; lead: ContactRow }
  | { action: "skip"; reason: MergeSkipReason };

function nameTokens(name: string | null): string[] {
  return (name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

function tokenMatch(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * ¿Los nombres pueden ser la misma persona? Red de seguridad del teléfono.
 *
 * Regla: el nombre de pila (primer token) de uno aparece —como prefijo— entre
 * los tokens del otro. Así pasan los casos reales ("Dani 🤗" ↔ "Daniela
 * Padilla", "Omar Cabrera" ↔ "Omar Antonio Cabrera", "Arq. Juan Pérez" ↔
 * "Juan Pérez") y NO pasan personas distintas que comparten número, incluso
 * con el mismo apellido ("Diego Fuentes" ↔ "Enrique Fuentes"): compartir
 * apellido no es identidad.
 *
 * Un nombre vacío o solo emojis no aporta evidencia en contra → compatible.
 */
export function namesCompatible(a: string | null, b: string | null): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length === 0 || tb.length === 0) return true;
  return tb.some((t) => tokenMatch(ta[0], t)) || ta.some((t) => tokenMatch(tb[0], t));
}

/**
 * Decisión PURA: dado un cliente y todos los contactos con su mismo teléfono,
 * ¿hay un lead que fusionar? Testeable sin BD.
 */
export function decideLeadClientMerge(
  client: ContactRow,
  samePhone: ContactRow[],
): LeadMergeDecision {
  const skip = (reason: MergeSkipReason): LeadMergeDecision => ({ action: "skip", reason });
  if (!client.shopify_customer_id) return skip("not_a_client");
  if (!client.phone) return skip("no_phone");
  if (client.anonymized_at) return skip("client_anonymized");

  const others = samePhone.filter((c) => c.id !== client.id);
  if (others.length === 0) return skip("no_lead_with_phone");
  // Tres o más tarjetas con el mismo número: no hay forma segura de saber
  // cuál es la misma persona. Mejor dos tarjetas que una fusión equivocada.
  if (others.length > 1) return skip("ambiguous_phone");

  const lead = others[0];
  if (lead.shopify_customer_id) return skip("other_is_client");
  if (lead.anonymized_at) return skip("lead_anonymized");
  if (
    lead.whaapy_contact_id &&
    client.whaapy_contact_id &&
    lead.whaapy_contact_id !== client.whaapy_contact_id
  ) {
    return skip("whaapy_identity_conflict");
  }
  if (!namesCompatible(client.full_name, lead.full_name)) return skip("name_mismatch");
  return { action: "merge", lead };
}

export interface LeadMergeResult {
  status: "merged" | "would_merge" | "skipped";
  reason: string | null;
  clientContactId: UUID;
  leadContactId: UUID | null;
  /** Filas movidas del lead al cliente, por tabla. */
  moved: Record<string, number> | null;
  absorbedOpportunityIds: UUID[];
}

interface MergeRpcResult {
  status: "merged" | "dry_run" | "skipped";
  reason?: string | null;
  moved?: Record<string, number> | null;
  lead_snapshot?: Json | null;
}

async function listContactsWithExactPhone(phoneE164: string): Promise<ContactRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("phone", phoneE164)
    .limit(10);
  if (error) throw error;
  return (data ?? []) as ContactRow[];
}

/**
 * Fusiona, si corresponde, el lead duplicado de `clientContactId` dentro de él.
 * Debe correr dentro de `withTenantContext`. `dryRun` no escribe nada: devuelve
 * lo que haría (`would_merge` + filas a mover).
 */
export async function mergeDuplicateLeadIntoClient(
  clientContactId: UUID,
  opts: { dryRun: boolean; trigger: LeadMergeTrigger },
): Promise<LeadMergeResult> {
  const base = {
    clientContactId,
    leadContactId: null as UUID | null,
    moved: null as Record<string, number> | null,
    absorbedOpportunityIds: [] as UUID[],
  };
  const client = await getContactById(clientContactId);
  if (!client) return { ...base, status: "skipped", reason: "client_not_found" };

  const samePhone = client.phone ? await listContactsWithExactPhone(client.phone) : [];
  const decision = decideLeadClientMerge(client, samePhone);
  if (decision.action === "skip") return { ...base, status: "skipped", reason: decision.reason };

  const { supabase } = getTenantScopedClient();
  const { data, error } = await supabase.rpc("merge_lead_contact_into_client", {
    p_lead_id: decision.lead.id,
    p_client_id: client.id,
    p_dry_run: opts.dryRun,
  });
  if (error) throw error;
  const r = data as MergeRpcResult;

  const withLead = { ...base, leadContactId: decision.lead.id, moved: r.moved ?? null };
  if (r.status === "dry_run") return { ...withLead, status: "would_merge", reason: null };
  if (r.status !== "merged") return { ...withLead, status: "skipped", reason: r.reason ?? "rpc_skipped" };

  // Foto completa del lead ANTES de borrarlo: es lo que permite reconstruirlo
  // si una fusión resultara equivocada.
  await recordAuditEvent({
    actorUserId: null,
    eventType: "contact_lead_merged_into_client",
    entityType: "contact",
    entityId: client.id,
    payload: {
      trigger: opts.trigger,
      client_contact_id: client.id,
      lead_contact_id: decision.lead.id,
      moved: r.moved ?? null,
      lead_snapshot: r.lead_snapshot ?? null,
    } as Json,
  });

  // El "Lead nuevo" del lead ahora convive con la cotización del cliente: se
  // archiva con la absorción existente (misma regla que cuando la cotización
  // llega después del lead). Si el cliente aún no tiene cotización, el lead
  // queda vivo: es una oportunidad legítima.
  const opps = await listOpportunities({ funnel: "venta", contactId: client.id });
  const quote = opps.find((o) => o.shopify_draft_order_id);
  let absorbed: UUID[] = [];
  if (quote) {
    const res = await absorbInitialStageOpportunities({
      contactId: client.id,
      absorbingOpportunityId: quote.id,
      trigger: "contact_merge",
    });
    absorbed = res.absorbedOpportunityIds;
  }

  return { ...withLead, status: "merged", reason: null, absorbedOpportunityIds: absorbed };
}
