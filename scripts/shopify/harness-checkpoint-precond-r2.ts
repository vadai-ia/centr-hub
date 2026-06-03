/* eslint-disable no-console */
/**
 * Harness de CHECKPOINT M7.2 — dos casos restantes del trigger F1→F2:
 *
 *   CASO A · Pre-condición no cumplida: invoca el servicio de
 *     producción `fireF1ToF2Trigger` sobre la HIJA (post_venta, con
 *     parent). El RPC debe cortar en la pre-condición
 *     (precondition_not_venta_parent), registrar audit
 *     trigger_f1_f2_skipped y NO crear nada. (El happy-path por
 *     webhook no puede producir un fallo de pre-condición sin un
 *     setup destructivo — borrar la etapa inicial de Post-venta —, así
 *     que se invoca el servicio real directamente, que es el MISMO que
 *     llama el worker.)
 *
 *   CASO B · Edge case R2: reasigna la F1 (ya Ganada) a otro vendedor
 *     usando la MISMA operación que la reasignación de M6
 *     (updateOpportunity + audit opportunity_reassigned sobre la F1).
 *     La hija F2 debe CONSERVAR su asesor heredado; el audit toca solo
 *     la F1. Al terminar, REVIERTE la F1 a su asesor original para no
 *     dejar producción alterada.
 *
 * Uso:
 *   npx tsx scripts/shopify/harness-checkpoint-precond-r2.ts \
 *     --org-slug centr \
 *     --f1-id b0698540-e5b5-4831-9745-c64baf22bfd1 \
 *     --f2-id 53fef1e6-236e-436a-a296-65bcb4da07b0
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { withTenantContext } from "@/lib/tenant/context";
import { getOpportunityById, updateOpportunity } from "@/lib/db/opportunities";
import { recordAuditEvent } from "@/lib/db/operational";
import { listActiveRealVendors } from "@/lib/db/users";
import { fireF1ToF2Trigger } from "@/lib/services/f1-to-f2-trigger";
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
  if (!out["org-slug"] || !out["f1-id"] || !out["f2-id"]) {
    console.error("Uso: tsx harness-checkpoint-precond-r2.ts --org-slug <s> --f1-id <uuid> --f2-id <uuid>");
    process.exit(2);
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const f1Id = args["f1-id"] as UUID;
  const f2Id = args["f2-id"] as UUID;

  const org = await getOrganizationBySlug(args["org-slug"]);
  if (!org) { console.error(`org ${args["org-slug"]} no encontrada`); process.exit(1); }

  await withTenantContext(org.id as UUID, async () => {
    const supabase = getSupabaseAdminClient();

    // =========================================================
    // CASO A — Pre-condición no cumplida (invocar sobre la hija)
    // =========================================================
    console.log("=== CASO A · PRE-CONDICIÓN NO CUMPLIDA (trigger sobre la hija) ===");
    const f2Before = await getOpportunityById(f2Id);
    console.log("Hija F2:", { id: f2Before?.id, funnel: f2Before?.funnel, parent: f2Before?.parent_opportunity_id });

    const { data: grandkidsBefore } = await supabase
      .from("opportunities").select("id")
      .eq("organization_id", org.id).eq("parent_opportunity_id", f2Id);

    const resA = await fireF1ToF2Trigger({
      opportunityId: f2Id,
      shopifyOrderId: null,
      shopifyEventId: `checkpoint-precond-${Date.now()}`,
    });
    console.log("Resultado del trigger:", resA);

    const { data: grandkidsAfter } = await supabase
      .from("opportunities").select("id")
      .eq("organization_id", org.id).eq("parent_opportunity_id", f2Id);

    const { data: auditA } = await supabase
      .from("audit_log").select("event_type, payload, created_at")
      .eq("organization_id", org.id)
      .eq("event_type", "trigger_f1_f2_skipped")
      .order("created_at", { ascending: false }).limit(1);
    console.log("Audit más reciente:", auditA?.[0]);
    console.log(
      resA.status === "skipped" &&
        resA.reason === "precondition_not_venta_parent" &&
        (grandkidsAfter ?? []).length === (grandkidsBefore ?? []).length
        ? "✅ CASO A OK: skipped/precondition_not_venta_parent, sin entidades nuevas.\n"
        : "❌ CASO A REVISAR.\n",
    );

    // =========================================================
    // CASO B — R2: reasignar F1 ganada; la hija NO cambia
    // =========================================================
    console.log("=== CASO B · R2 (reasignar F1 ganada → hija conserva asesor) ===");
    const f1Before = await getOpportunityById(f1Id);
    if (!f1Before) { console.error("F1 no encontrada"); process.exit(1); }
    const f2AdvisorBefore = f2Before?.assigned_advisor_id ?? null;
    const originalF1Advisor = f1Before.assigned_advisor_id;
    console.log("Antes →", { f1_advisor: originalF1Advisor, f2_advisor: f2AdvisorBefore });

    const vendors = await listActiveRealVendors(org.id as UUID);
    const newVendor = vendors.find((v) => v.id !== originalF1Advisor);
    if (!newVendor) { console.error("No hay un vendedor distinto disponible para reasignar."); process.exit(1); }
    console.log("Reasignando F1 a:", { membershipId: newVendor.id, name: newVendor.profile.full_name });

    // Misma operación que reassignOpportunity (M6): solo toca la F1.
    const nowIso = new Date().toISOString();
    await updateOpportunity(f1Id, {
      assigned_advisor_id: newVendor.id,
      last_modified_at: nowIso,
      last_modified_source: "platform",
    });
    await recordAuditEvent({
      actorUserId: null,
      eventType: "opportunity_reassigned",
      entityType: "opportunity",
      entityId: f1Id,
      payload: { from_membership_id: originalF1Advisor, to_membership_id: newVendor.id, contact_id: f1Before.contact_id, checkpoint: "R2" },
    });

    const f1After = await getOpportunityById(f1Id);
    const f2After = await getOpportunityById(f2Id);
    console.log("Después →", { f1_advisor: f1After?.assigned_advisor_id, f2_advisor: f2After?.assigned_advisor_id });

    // ¿Algún audit de reasignación tocó la F2? (no debería)
    const { data: f2ReassignAudits } = await supabase
      .from("audit_log").select("event_type, created_at")
      .eq("organization_id", org.id)
      .eq("entity_id", f2Id)
      .eq("event_type", "opportunity_reassigned");

    const f1Changed = f1After?.assigned_advisor_id === newVendor.id;
    const f2Unchanged = (f2After?.assigned_advisor_id ?? null) === f2AdvisorBefore;
    const noF2Audit = (f2ReassignAudits ?? []).length === 0;
    console.log({ f1Changed, f2Unchanged, noF2ReassignAudit: noF2Audit });
    console.log(
      f1Changed && f2Unchanged && noF2Audit
        ? "✅ CASO B OK: F1 cambió de asesor, la hija F2 conservó el heredado, audit solo sobre F1."
        : "❌ CASO B REVISAR.",
    );

    // --- Revertir F1 a su asesor original (restaurar producción) ---
    await updateOpportunity(f1Id, {
      assigned_advisor_id: originalF1Advisor,
      last_modified_at: new Date().toISOString(),
      last_modified_source: "platform",
    });
    await recordAuditEvent({
      actorUserId: null,
      eventType: "opportunity_reassigned",
      entityType: "opportunity",
      entityId: f1Id,
      payload: { from_membership_id: newVendor.id, to_membership_id: originalF1Advisor, contact_id: f1Before.contact_id, checkpoint: "R2_revert" },
    });
    const f1Restored = await getOpportunityById(f1Id);
    const f2Final = await getOpportunityById(f2Id);
    console.log("Revertido →", { f1_advisor: f1Restored?.assigned_advisor_id, f2_advisor: f2Final?.assigned_advisor_id });
    console.log(
      f1Restored?.assigned_advisor_id === originalF1Advisor && (f2Final?.assigned_advisor_id ?? null) === f2AdvisorBefore
        ? "✅ Estado de producción restaurado (F1 con su asesor original, F2 intacta)."
        : "❌ Revert incompleto — revisar manualmente.",
    );
  }, { source: "script" });
}

main().catch((err: Error) => {
  console.error("harness falló:", err.message);
  process.exit(1);
});
