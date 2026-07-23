"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenantContext } from "@/lib/tenant/context";
import { resolveAdminContext } from "@/lib/auth/admin-guard";
import { getInngestClient } from "@/lib/inngest/client";
import {
  deleteTagMappingByNormalized,
  getTagMappingByNormalized,
  listTagMappings,
  upsertTagMapping,
} from "@/lib/db/configuration";
import { listRealVendorsForMapping } from "@/lib/db/users";
import {
  aggregateDetectedTags,
  findContactsWithTag,
  findOrdersWithTag,
  reattributeContacts,
  reattributeOrders,
} from "@/lib/db/tag-aggregation";
import { recordAuditEvent } from "@/lib/db/operational";
import {
  PLATFORM_TAG_REPROCESS_EVENT,
  type TagReprocessEnvelope,
} from "@/lib/inngest/functions/tag-reprocess";
import type {
  TagMappingActionResult,
  TagMappingView,
  TagReprocessResult,
  TagVendorOption,
} from "@/lib/types/admin";
import type { UUID } from "@/lib/types/database";

/**
 * Server actions del mapeo de tags ↔ vendedor (M7.2, Bloque 5).
 * Solo admin/superadmin. El dropdown de vendedores excluye al usuario
 * sistema "Histórico" (R10) e incluye vendedores reales desactivados.
 */

/** Conteo de entidades sobre el cual el re-proceso pasa a background. */
const REPROCESS_INLINE_THRESHOLD = 200;

type LoadResult =
  | { ok: true; mappings: TagMappingView[]; vendors: TagVendorOption[] }
  | { ok: false; message: string };

export async function loadAdminTagMappings(): Promise<LoadResult> {
  const admin = await resolveAdminContext("admin-mapeo-tags");
  if (!admin.ok) return admin;

  return withTenantContext(admin.ctx.orgId, async () => {
    const [detected, mappings, vendors] = await Promise.all([
      aggregateDetectedTags(),
      listTagMappings(),
      listRealVendorsForMapping(admin.ctx.orgId),
    ]);

    const vendorMap = new Map(
      vendors.map((v) => [v.id, { name: v.profile.full_name, active: v.is_active }]),
    );
    const detectedMap = new Map(detected.map((d) => [d.normalized, d]));
    const mappingMap = new Map(mappings.map((m) => [m.normalized_tag, m]));

    const allNormalized = new Set<string>([
      ...detected.map((d) => d.normalized),
      ...mappings.map((m) => m.normalized_tag),
    ]);

    const views: TagMappingView[] = Array.from(allNormalized).map((norm) => {
      const row = mappingMap.get(norm);
      const det = detectedMap.get(norm);
      const mappedId = row?.mapped_membership_id ?? null;
      const vendor = mappedId ? vendorMap.get(mappedId) : undefined;
      return {
        normalized: norm,
        original: det?.original ?? row?.original_tag ?? norm,
        count: det?.count ?? 0,
        classification: row?.classification ?? "informational",
        mapped_membership_id: mappedId,
        mapped_vendor_name: vendor?.name ?? null,
        mapped_vendor_active: mappedId ? (vendor?.active ?? false) : null,
      };
    });
    views.sort((a, b) => a.original.localeCompare(b.original, "es"));

    const vendorOptions: TagVendorOption[] = vendors.map((v) => ({
      membershipId: v.id,
      fullName: v.profile.full_name,
      isActive: v.is_active,
    }));

    return { ok: true, mappings: views, vendors: vendorOptions };
  }, { source: "user_session" });
}

/**
 * Normaliza una tag igual que el parser de Shopify
 * (`lib/services/tag-parser.ts` → `normalizeTag`): trim + lowercase. Debe
 * coincidir EXACTAMENTE para que una tag creada a mano y la misma tag que
 * luego llegue de Shopify colapsen a la misma fila (no duplicar).
 */
function normalizeTagInput(raw: string): string {
  return raw.trim().toLowerCase();
}

const createMappingSchema = z.object({
  tag: z.string().trim().min(1).max(120),
  classification: z.enum(["vendor", "informational"]).default("vendor"),
  membershipId: z.string().uuid().nullable().optional(),
});

/**
 * Creación PROACTIVA de una fila de mapeo (Bloque B). Resuelve la deuda:
 * un vendedor nuevo aparece en el dropdown pero no hay ninguna fila de tag
 * a la cual asignarlo hasta que su tag aterrice en datos de Shopify ya
 * ingeridos. Aquí el admin escribe la tag y le asigna su vendedor sin
 * esperar a Shopify.
 *
 * Anti-duplicado: la tag se normaliza igual que el parser y la unicidad
 * es `(organization_id, normalized_tag)`. Si ya existe una fila (sea
 * creada a mano, auto-creada por ingest, o detectada), se BLOQUEA con
 * mensaje accionable — el admin la edita desde la lista, no la re-crea.
 * Cuando la misma tag llegue después de Shopify, el parser encuentra esta
 * fila por `normalized_tag` y NO crea otra.
 */
export async function createTagMappingAction(
  raw: unknown,
): Promise<TagMappingActionResult> {
  const parsed = createMappingSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Datos del mapeo inválidos." };
  const input = parsed.data;
  const normalized = normalizeTagInput(input.tag);
  if (normalized.length === 0) {
    return { ok: false, message: "La tag no puede quedar vacía." };
  }
  const admin = await resolveAdminContext("admin-mapeo-tags");
  if (!admin.ok) return admin;

  return withTenantContext(admin.ctx.orgId, async () => {
    // Anti-duplicado: no re-crear una tag ya existente.
    const existing = await getTagMappingByNormalized(normalized);
    if (existing) {
      return {
        ok: false,
        message:
          "Ya existe un mapeo para esta tag. Edítalo desde la lista (botón Cambiar/Reclasificar).",
      };
    }

    let membershipId: UUID | null = null;
    if (input.classification === "vendor") {
      if (!input.membershipId) {
        return { ok: false, message: "Selecciona un vendedor para el mapeo De vendedor." };
      }
      // Defensa R10: solo vendedores reales (la lista excluye "Histórico").
      const vendors = await listRealVendorsForMapping(admin.ctx.orgId);
      if (!vendors.some((v) => v.id === input.membershipId)) {
        return { ok: false, message: "El vendedor seleccionado no es válido." };
      }
      membershipId = input.membershipId;
    }

    await upsertTagMapping({
      normalized_tag: normalized,
      // Preserva lo que el admin tecleó como `original_tag` (display);
      // cuando llegue de Shopify, la vista prioriza el original detectado.
      original_tag: input.tag.trim(),
      classification: input.classification,
      mapped_membership_id: membershipId,
      created_by_user_id: admin.ctx.userId,
    });
    await recordAuditEvent({
      actorUserId: admin.ctx.userId,
      eventType: "tag_mapping_created_manually",
      entityType: "tag_mapping",
      entityId: null,
      payload: {
        normalized_tag: normalized,
        classification: input.classification,
        mapped_membership_id: membershipId,
      },
    });
    revalidatePath("/admin/mapeo-tags");

    const result = await loadAdminTagMappings();
    if (!result.ok) return { ok: false, message: result.message };
    return { ok: true, mappings: result.mappings };
  }, { source: "user_session" });
}

const reclassifySchema = z.object({
  normalizedTag: z.string().trim().min(1),
  originalTag: z.string().trim().min(1),
  classification: z.enum(["vendor", "informational"]),
  membershipId: z.string().uuid().nullable().optional(),
});

export async function reclassifyTagAction(
  raw: unknown,
): Promise<TagMappingActionResult> {
  const parsed = reclassifySchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Datos de clasificación inválidos." };
  const input = parsed.data;
  const admin = await resolveAdminContext("admin-mapeo-tags");
  if (!admin.ok) return admin;

  return withTenantContext(admin.ctx.orgId, async () => {
    let membershipId: UUID | null = null;
    if (input.classification === "vendor") {
      if (!input.membershipId) {
        return { ok: false, message: "Selecciona un vendedor para clasificar como De vendedor." };
      }
      // Defensa R10: el vendedor debe ser real (no sistema). La lista
      // de mapeo ya excluye al "Histórico".
      const vendors = await listRealVendorsForMapping(admin.ctx.orgId);
      if (!vendors.some((v) => v.id === input.membershipId)) {
        return { ok: false, message: "El vendedor seleccionado no es válido." };
      }
      membershipId = input.membershipId;
    }

    await upsertTagMapping({
      normalized_tag: input.normalizedTag,
      original_tag: input.originalTag,
      classification: input.classification,
      mapped_membership_id: membershipId,
      created_by_user_id: admin.ctx.userId,
    });
    await recordAuditEvent({
      actorUserId: admin.ctx.userId,
      eventType: "tag_reclassified",
      entityType: "tag_mapping",
      entityId: null,
      payload: {
        normalized_tag: input.normalizedTag,
        classification: input.classification,
        mapped_membership_id: membershipId,
      },
    });
    revalidatePath("/admin/mapeo-tags");

    const result = await loadAdminTagMappings();
    if (!result.ok) return { ok: false, message: result.message };
    return { ok: true, mappings: result.mappings };
  }, { source: "user_session" });
}

const deleteSchema = z.object({
  normalizedTag: z.string().trim().min(1),
});

/**
 * Limpieza manual de una tag huérfana (M7.2 fix #5). Solo se permite
 * si NINGUNA entidad (orden o contacto) la lleva — se re-verifica en
 * servidor, no se confía en el conteo del cliente. Si hay entidades,
 * se bloquea con mensaje (no hay purga automática: decisión del admin).
 */
export async function deleteTagMappingAction(
  raw: unknown,
): Promise<TagMappingActionResult> {
  const parsed = deleteSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Identificador de tag inválido." };
  const admin = await resolveAdminContext("admin-mapeo-tags");
  if (!admin.ok) return admin;

  return withTenantContext(admin.ctx.orgId, async () => {
    const [orders, contacts] = await Promise.all([
      findOrdersWithTag(parsed.data.normalizedTag),
      findContactsWithTag(parsed.data.normalizedTag),
    ]);
    const total = orders.length + contacts.length;
    if (total > 0) {
      return {
        ok: false,
        message: `No se puede eliminar: ${total} entidad${total === 1 ? "" : "es"} llevan esta tag. Solo se eliminan tags sin entidades.`,
      };
    }

    const deleted = await deleteTagMappingByNormalized(parsed.data.normalizedTag);
    await recordAuditEvent({
      actorUserId: admin.ctx.userId,
      eventType: "tag_mapping_deleted",
      entityType: "tag_mapping",
      entityId: null,
      payload: { normalized_tag: parsed.data.normalizedTag, rows_deleted: deleted },
    });
    revalidatePath("/admin/mapeo-tags");

    const result = await loadAdminTagMappings();
    if (!result.ok) return { ok: false, message: result.message };
    return { ok: true, mappings: result.mappings };
  }, { source: "user_session" });
}

const reprocessSchema = z.object({
  normalizedTag: z.string().trim().min(1),
  originalTag: z.string().trim().min(1),
  membershipId: z.string().uuid().nullable().optional(),
});

export async function reprocessTagAction(
  raw: unknown,
): Promise<TagReprocessResult> {
  const parsed = reprocessSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Parámetros de re-proceso inválidos." };
  const input = parsed.data;
  const admin = await resolveAdminContext("admin-mapeo-tags");
  if (!admin.ok) return admin;

  return withTenantContext(admin.ctx.orgId, async () => {
    const membershipId = input.membershipId ?? null;
    // Candidatos = órdenes + contactos que llevan la tag (fix M7.2 #3).
    const [orders, contacts] = await Promise.all([
      findOrdersWithTag(input.normalizedTag),
      findContactsWithTag(input.normalizedTag),
    ]);
    const totalCandidates = orders.length + contacts.length;

    if (totalCandidates === 0) {
      return { ok: true, mode: "none", count: 0 };
    }

    // Conteo grande → background con notificación al admin al terminar.
    if (totalCandidates > REPROCESS_INLINE_THRESHOLD) {
      const envelope: TagReprocessEnvelope = {
        organizationId: admin.ctx.orgId,
        normalizedTag: input.normalizedTag,
        originalTag: input.originalTag,
        membershipId,
        actorUserId: admin.ctx.userId,
      };
      await getInngestClient().send({
        name: PLATFORM_TAG_REPROCESS_EVENT,
        data: envelope as unknown as Record<string, unknown>,
      });
      return { ok: true, mode: "background", count: totalCandidates };
    }

    // Conteo pequeño → inline (órdenes + contactos).
    const ordersAffected = await reattributeOrders(orders, membershipId);
    const contactsAffected = await reattributeContacts(contacts, membershipId);
    const affected = ordersAffected + contactsAffected;
    await recordAuditEvent({
      actorUserId: admin.ctx.userId,
      eventType: "tag_attribution_reprocessed",
      entityType: "tag_mapping",
      entityId: null,
      payload: {
        normalized_tag: input.normalizedTag,
        mapped_membership_id: membershipId,
        affected_entities: affected,
        orders_affected: ordersAffected,
        contacts_affected: contactsAffected,
        mode: "inline",
      },
    });
    return { ok: true, mode: "inline", count: affected };
  }, { source: "user_session" });
}
