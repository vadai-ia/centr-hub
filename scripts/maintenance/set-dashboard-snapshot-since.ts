/* eslint-disable no-console */
/**
 * Fija (o quita) el CORTE POR ANTIGÜEDAD del snapshot del dashboard de
 * una organización: `config.dashboard.pipeline_snapshot_since`.
 *
 * Qué acota: solo "Activas (con cotización)" y "Pipeline $ actual" —
 * las dos métricas snapshot del funnel Venta, en las tarjetas y en el
 * desglose por vendedor. Revenue, cotizaciones, ganadas, perdidas y win
 * rate NO se tocan: esas ya responden al selector de periodo.
 *
 * **El corte es SOLO del dashboard.** El kanban del pipeline sigue
 * mostrando todo, así que con el corte puesto las dos vistas divergen a
 * propósito. La UI lo declara con un chip; ver
 * `lib/services/dashboard-snapshot-window.ts`.
 *
 * NO borra ni cancela nada: es un filtro de lectura. Quitarlo
 * (`--clear`) devuelve el dashboard al comportamiento previo.
 *
 * Uso:
 *   npm run maintenance:set-dashboard-snapshot-since -- --org-slug centr --since 2026-05-01 --dry-run
 *   npm run maintenance:set-dashboard-snapshot-since -- --org-slug centr --since 2026-05-01
 *   npm run maintenance:set-dashboard-snapshot-since -- --org-slug centr --clear
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { getOrganizationBySlug, getOrganizationById, updateOrganization } from "@/lib/db/organizations";
import { recordAuditEvent } from "@/lib/db/operational";
import { withTenantContext } from "@/lib/tenant/context";
import { resolvePipelineSnapshotWindow } from "@/lib/services/dashboard-snapshot-window";
import type { Json, UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const DRY_RUN = process.argv.includes("--dry-run");
const CLEAR = process.argv.includes("--clear");

async function main() {
  const slug = arg("--org-slug");
  const since = arg("--since");
  if (!slug || (!since && !CLEAR)) {
    console.error("Uso: --org-slug <slug> (--since YYYY-MM-DD | --clear) [--dry-run]");
    process.exit(1);
  }

  const org = await getOrganizationBySlug(slug);
  if (!org) {
    console.error(`org "${slug}" no encontrada`);
    process.exit(1);
  }

  // Valida contra el MISMO resolver que consume el dashboard: si aquí no
  // parsea, allá tampoco y el corte quedaría inerte sin avisar.
  if (!CLEAR) {
    const probe = resolvePipelineSnapshotWindow({ dashboard: { pipeline_snapshot_since: since } });
    if (!probe.sinceDate) {
      console.error(`"${since}" no es una fecha válida (formato YYYY-MM-DD).`);
      process.exit(1);
    }
  }

  await withTenantContext(
    org.id as UUID,
    async () => {
      const current = await getOrganizationById(org.id as UUID);
      const baseConfig: Record<string, Json> =
        current?.config && typeof current.config === "object" && !Array.isArray(current.config)
          ? { ...(current.config as Record<string, Json>) }
          : {};
      const baseDashboard: Record<string, Json> =
        baseConfig.dashboard &&
        typeof baseConfig.dashboard === "object" &&
        !Array.isArray(baseConfig.dashboard)
          ? { ...(baseConfig.dashboard as Record<string, Json>) }
          : {};

      const before = resolvePipelineSnapshotWindow(current?.config ?? null).sinceDate;
      const after = CLEAR ? null : (since as string);

      console.log(`\norg: ${slug}`);
      console.log(`  corte actual : ${before ?? "(ninguno)"}`);
      console.log(`  corte nuevo  : ${after ?? "(ninguno)"}`);

      if (before === after) {
        console.log("\nSin cambios.\n");
        return;
      }
      if (DRY_RUN) {
        console.log("\n(dry run) Nada escrito. Quitá --dry-run para aplicar.\n");
        return;
      }

      if (CLEAR) delete baseDashboard.pipeline_snapshot_since;
      else baseDashboard.pipeline_snapshot_since = after as Json;
      baseConfig.dashboard = baseDashboard as Json;

      await updateOrganization(org.id as UUID, { config: baseConfig as Json });
      await recordAuditEvent({
        actorUserId: null,
        eventType: "dashboard_snapshot_since_changed",
        entityType: "organization",
        entityId: org.id as UUID,
        payload: { from: before, to: after, source: "script:set-dashboard-snapshot-since" },
      });
      console.log(`\n✓ aplicado.\n`);
    },
    { source: "script" },
  );
}

main().catch((e: Error) => {
  console.error("falló:", e.message);
  process.exit(1);
});
