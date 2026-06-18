/* eslint-disable no-console */
/**
 * Snapshot MANUAL del histórico de metas — corrida de validación (la versión
 * automática vive en el cron mensual de Inngest `goal-monthly-snapshot`, que
 * corre el día 1 a las 01:00 MX sobre el mes recién cerrado).
 *
 * Ejecuta la MISMA lógica que el cron (`snapshotMonthlyGoals`), no un INSERT
 * dummy: lee las metas activas, calcula el logrado del mes con las fuentes del
 * Dashboard y congela target/logrado/pct en `goal_results`.
 *
 * Idempotente (real-run se salta si ya hay snapshots de ese mes). El dry-run
 * calcula y MUESTRA las filas sin escribir.
 *
 * Uso:
 *   # mes anterior (lo que haría el cron), solo mostrar:
 *   npm run maintenance:snapshot-goal-results -- --org-slug centr --dry-run
 *   # un mes específico:
 *   npm run maintenance:snapshot-goal-results -- --org-slug centr --month 2026-05 --dry-run
 *   # aplicar (escribe a goal_results):
 *   npm run maintenance:snapshot-goal-results -- --org-slug centr --month 2026-05
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { getTenantScopedClient } from "@/lib/db/client";
import { snapshotMonthlyGoals } from "@/lib/services/goal-snapshot";
import {
  previousMonthDateKey,
  resolveMonthPeriod,
  resolvePreviousMonthPeriod,
} from "@/lib/time/period";
import { GOAL_METRIC_LABELS, formatGoalValue } from "@/lib/metas/schema";
import type { ResolvedPeriod } from "@/lib/time/period";
import type { UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

function parseArgs() {
  let orgSlug: string | null = null;
  let month: string | null = null;
  let dryRun = false;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--org-slug") orgSlug = argv[++i] ?? null;
    else if (argv[i] === "--month") month = argv[++i] ?? null;
    else if (argv[i] === "--dry-run") dryRun = true;
  }
  if (!orgSlug) {
    console.error("Uso: --org-slug <slug> [--month YYYY-MM] [--dry-run]");
    process.exit(2);
  }
  return { orgSlug, month, dryRun };
}

async function loadAdvisorNameMap(): Promise<Map<UUID, string>> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("memberships")
    .select("id, profile:user_profiles(full_name)")
    .eq("organization_id", organizationId);
  if (error) throw error;
  const map = new Map<UUID, string>();
  for (const row of (data ?? []) as Array<{
    id: UUID;
    profile: Array<{ full_name: string | null }> | { full_name: string | null } | null;
  }>) {
    const profile = Array.isArray(row.profile) ? row.profile[0] : row.profile;
    if (profile?.full_name) map.set(row.id, profile.full_name);
  }
  return map;
}

async function main() {
  const { orgSlug, month, dryRun } = parseArgs();
  void getSupabaseAdminClient();

  const org = await getOrganizationBySlug(orgSlug);
  if (!org) {
    console.error(`org ${orgSlug} no encontrada`);
    process.exit(1);
  }

  let period: ResolvedPeriod;
  let periodMonth: string;
  if (month) {
    const p = resolveMonthPeriod(month);
    if (!p) {
      console.error(`--month inválido: "${month}" (formato YYYY-MM)`);
      process.exit(2);
    }
    period = p;
    periodMonth = `${month}-01`;
  } else {
    period = resolvePreviousMonthPeriod();
    periodMonth = previousMonthDateKey();
  }

  console.log(
    `Snapshot de metas en "${org.name}" — mes ${periodMonth} ` +
      `(${period.startLabel}…${period.endLabel}) · dry-run=${dryRun}\n`,
  );

  await withTenantContext(
    org.id as UUID,
    async () => {
      const names = await loadAdvisorNameMap();
      const res = await snapshotMonthlyGoals({ period, periodMonth, dryRun });

      if (res.alreadyExists) {
        console.log(
          dryRun
            ? "⚠ Ya hay snapshots de este mes (un real-run se saltaría). Mostrando los valores calculados:\n"
            : "⚠ Ya había snapshots de este mes — no se escribió nada (idempotente).\n",
        );
      }

      if (res.rows.length === 0 && !res.alreadyExists) {
        console.log("No hay metas activas para snapshotear.");
        return;
      }

      if (res.rows.length > 0) {
        console.log("Sujeto              | Métrica              | Objetivo     | Logrado      | %");
        console.log("--------------------+----------------------+--------------+--------------+------");
        for (const r of res.rows) {
          const subject = r.advisor_membership_id
            ? names.get(r.advisor_membership_id as UUID) ?? String(r.advisor_membership_id)
            : "Equipo";
          const target = formatGoalValue(r.metric, Number(r.target_value));
          const achieved = formatGoalValue(r.metric, Number(r.achieved_value));
          console.log(
            `${subject.padEnd(19)} | ${GOAL_METRIC_LABELS[r.metric].padEnd(20)} | ` +
              `${target.padStart(12)} | ${achieved.padStart(12)} | ${String(r.pct).padStart(5)}`,
          );
        }
      }

      console.log(
        dryRun
          ? `\n(dry-run: nada escrito. Re-correr SIN --dry-run para aplicar — ${res.rows.length} fila(s))`
          : `\n✓ Escritas ${res.written} fila(s) en goal_results.`,
      );
    },
    { source: "script" },
  );
}

main().catch((err: Error) => {
  console.error("snapshot-goal-results falló:", err.message);
  process.exit(1);
});
