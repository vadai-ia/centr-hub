import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Guard estático del contrato "reasignación manual NO la pisan los hooks"
 * (M9.2). Sin infra nueva (no levanta Postgres).
 *
 * El acoplamiento crítico que protege: la reasignación manual de una opp
 * (núcleo `reassignOpportunityAdvisor`) emite un evento de auditoría que
 * la guarda del hook automático (`reattribute_postventa_child_advisor`,
 * 0022) reconoce como "manual" para NO pisarla. Si alguien cambia el
 * string del evento en CUALQUIERA de los dos lados sin tocar el otro, el
 * guard se rompe silenciosamente: `tsc` no lo ve (uno es TS, el otro SQL).
 * Este test asierta que ambos lados siguen hablando el mismo evento, y
 * que la F1 de Venta sigue protegida por la regla "solo NULL" (0023).
 */

const ROOT = path.resolve(__dirname, "..");
const MIGRATIONS_DIR = path.resolve(ROOT, "supabase", "migrations");

function readService(): string {
  return readFileSync(
    path.resolve(ROOT, "lib", "services", "opportunity-reassignment.ts"),
    "utf8",
  ).toLowerCase();
}

/** Migración de mayor número que define la función dada. */
function latestMigrationDefining(signature: string): { file: string; sql: string } {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  let latest: { file: string; sql: string } | null = null;
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    if (sql.toLowerCase().includes(signature.toLowerCase())) {
      latest = { file, sql };
    }
  }
  if (!latest) throw new Error(`Ninguna migración define ${signature}`);
  return latest;
}

describe("contrato: reasignación manual vs hooks automáticos", () => {
  const service = readService();

  it("el servicio emite el evento 'opportunity_reassigned' con el actor humano", () => {
    expect(service).toContain('opportunity_reassigned_event = "opportunity_reassigned"');
    // El recordAuditEvent debe pasar actorUserId (no null) y el evento.
    expect(service).toMatch(/actoruserid:\s*input\.actoruserid/);
    expect(service).toContain("eventtype: opportunity_reassigned_event");
  });

  it("la guarda del hook 0022 detecta ese evento + actor no nulo como manual", () => {
    const { sql } = latestMigrationDefining(
      "function public.reattribute_postventa_child_advisor",
    );
    const lower = sql.toLowerCase();
    // El IN-list de la guarda incluye el evento que emite el servicio.
    expect(lower).toContain("'opportunity_reassigned'");
    expect(lower).toMatch(/event_type in \([^)]*'opportunity_reassigned'[^)]*\)/);
    expect(lower).toContain("actor_user_id is not null");
    expect(lower).toContain("manual_reassignment_detected");
  });

  it("el evento que emite el servicio ∈ IN-list de la guarda (cross-check)", () => {
    const { sql } = latestMigrationDefining(
      "function public.reattribute_postventa_child_advisor",
    );
    const lower = sql.toLowerCase();
    const m = lower.match(/event_type in \(([^)]*)\)/);
    expect(m, "no se encontró el IN-list de la guarda").toBeTruthy();
    const inList = m![1];
    // El string emitido por el servicio (constante) debe estar en la lista.
    expect(inList).toContain("opportunity_reassigned");
  });

  it("la F1 de Venta sigue protegida por 'solo NULL' (0023 no pisa un valor manual)", () => {
    const { sql } = latestMigrationDefining(
      "function public.reattribute_venta_opportunity_advisor",
    );
    const lower = sql.toLowerCase();
    // Cualquier asesor no-NULL (incluida la reasignación manual) se respeta.
    expect(lower).toMatch(/assigned_advisor_id is not null/);
    expect(lower).toContain("opportunity_already_assigned");
  });

  it("la reconciliación horaria re-corre los MISMOS RPC (respeta la guarda)", () => {
    const recon = readFileSync(
      path.resolve(ROOT, "lib", "services", "advisor-reconciliation.ts"),
      "utf8",
    ).toLowerCase();
    expect(recon).toContain("reattributeventaopportunityadvisor".toLowerCase());
    expect(recon).toContain("reattributepostventachildadvisor".toLowerCase());
  });
});
