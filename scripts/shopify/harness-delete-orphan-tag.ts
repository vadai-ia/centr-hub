/* eslint-disable no-console */
/**
 * Harness one-shot: elimina un mapping de tag HUÉRFANO (M7.2 fix #5).
 * Re-verifica que 0 entidades (orders + contactos) la lleven ANTES de
 * borrar — aborta si encuentra alguna. Misma guarda que la action de
 * UI; este harness aplica el caso puntual de "ginajimenez".
 *
 * Uso:
 *   npx tsx scripts/shopify/harness-delete-orphan-tag.ts \
 *     --org-slug centr --normalized ginajimenez
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { withTenantContext } from "@/lib/tenant/context";
import { findContactsWithTag, findOrdersWithTag } from "@/lib/db/tag-aggregation";
import { deleteTagMappingByNormalized, getTagMappingByNormalized } from "@/lib/db/configuration";
import { recordAuditEvent } from "@/lib/db/operational";
import type { UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

function parseArgs() {
  const argv = process.argv.slice(2);
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, "");
    const v = argv[i + 1];
    if (k && v) out[k] = v;
  }
  if (!out["org-slug"] || !out.normalized) {
    console.error("Uso: tsx harness-delete-orphan-tag.ts --org-slug <s> --normalized <tag>");
    process.exit(2);
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const normalized = args.normalized;
  const org = await getOrganizationBySlug(args["org-slug"]);
  if (!org) { console.error("org no encontrada"); process.exit(1); }

  await withTenantContext(org.id as UUID, async () => {
    const row = await getTagMappingByNormalized(normalized);
    if (!row) { console.log(`No existe mapping '${normalized}' — nada que borrar.`); return; }
    console.log("Mapping a evaluar:", { normalized_tag: row.normalized_tag, original_tag: row.original_tag, classification: row.classification });

    const [orders, contacts] = await Promise.all([
      findOrdersWithTag(normalized),
      findContactsWithTag(normalized),
    ]);
    const total = orders.length + contacts.length;
    console.log("Entidades que la llevan → orders:", orders.length, "| contactos:", contacts.length, "| total:", total);
    if (total > 0) {
      console.log("❌ ABORTO: la tag tiene entidades; no es huérfana. No se borra.");
      process.exit(1);
    }

    const deleted = await deleteTagMappingByNormalized(normalized);
    await recordAuditEvent({
      actorUserId: null,
      eventType: "tag_mapping_deleted",
      entityType: "tag_mapping",
      entityId: null,
      payload: { normalized_tag: normalized, rows_deleted: deleted, via: "harness_orphan_cleanup" },
    });
    console.log(`✅ Eliminado mapping huérfano '${normalized}' (filas borradas: ${deleted}). Audit: tag_mapping_deleted.`);

    const after = await getTagMappingByNormalized(normalized);
    console.log("Verificación post-borrado:", after === null ? "ya no existe ✅" : "AÚN EXISTE ❌");
  }, { source: "script" });
}

main().catch((err: Error) => { console.error("harness falló:", err.message); process.exit(1); });
