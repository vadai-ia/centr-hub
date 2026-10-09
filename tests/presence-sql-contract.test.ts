import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Guard estático de la presencia (0057). Sin infra nueva (no levanta Postgres).
 *
 * Protege tres acoplamientos que `tsc` no puede ver:
 *
 *  1. El nombre y los parámetros del RPC viven en SQL y en el data layer.
 *     Renombrar uno deja el latido fallando en silencio — y el síntoma es
 *     "nadie aparece conectado", indistinguible de "nadie entró".
 *  2. El latido tiene que estar montado en el layout autenticado. Si alguien
 *     lo quita, la pantalla sigue existiendo y la tabla sigue ahí: el
 *     historial simplemente deja de crecer, sin un solo error.
 *  3. El RPC tiene que ser ATÓMICO. Sin el lock por (org, persona), dos
 *     pestañas abren dos tramos para una sola sesión y el historial muestra
 *     conexiones simultáneas que nunca existieron.
 */

const ROOT = path.resolve(__dirname, "..");
const MIGRATIONS_DIR = path.resolve(ROOT, "supabase", "migrations");

function latestMigrationDefining(signature: string): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  let latest: string | null = null;
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    if (sql.toLowerCase().includes(signature.toLowerCase())) latest = sql;
  }
  if (!latest) throw new Error(`Ninguna migración define ${signature}`);
  return latest;
}

const read = (rel: string) => readFileSync(path.resolve(ROOT, rel), "utf8");

describe("contrato: presencia (TS ↔ SQL)", () => {
  const sql = latestMigrationDefining("function public.record_user_presence");
  const dataLayer = read("lib/db/presence.ts");

  it("el data layer invoca el MISMO nombre de RPC que define la migración", () => {
    expect(dataLayer).toContain('rpc("record_user_presence"');
  });

  it("y pasa exactamente los parámetros que el RPC declara", () => {
    for (const arg of ["p_organization_id", "p_user_id", "p_gap_minutes"]) {
      expect(sql).toContain(arg);
      expect(dataLayer).toContain(`${arg}:`);
    }
  });

  it("el RPC serializa el latido con un lock por (org, persona)", () => {
    // Es leer-y-luego-escribir: sin esto, dos pestañas crean dos tramos.
    // Un índice único no sirve — la unicidad depende del TIEMPO.
    expect(sql).toContain("pg_advisory_xact_lock");
  });

  it("el RPC extiende el tramo vigente en vez de insertar siempre", () => {
    expect(sql).toMatch(/update\s+public\.user_activity_sessions/i);
    expect(sql).toContain("last_seen_at = now()");
  });

  it("la tabla lleva RLS con las 4 tenant policies", () => {
    expect(sql).toMatch(
      /alter table public\.user_activity_sessions\s+enable row level security/i,
    );
    for (const op of ["select", "insert", "update", "delete"]) {
      expect(sql).toContain(`user_activity_sessions_tenant_${op}`);
    }
  });

  it("el RPC no es invocable por anon/authenticated", () => {
    expect(sql).toMatch(
      /revoke all on function public\.record_user_presence\([^)]*\) from public/i,
    );
    expect(sql).toMatch(/grant execute on function public\.record_user_presence/i);
  });
});

describe("contrato: el latido está montado donde late", () => {
  const layout = read("app/(dashboard)/layout.tsx");

  it("el layout autenticado monta el latido", () => {
    // En el layout y no en cada página: una pantalla nueva no puede olvidarlo.
    expect(layout).toContain("PresenceHeartbeat");
    expect(layout).toContain("@/components/ui/presence-heartbeat");
  });

  it("el latido solo corre con la pestaña visible", () => {
    // Una pestaña olvidada en segundo plano reportaría "conectado" todo el
    // fin de semana, que es justo lo contrario de lo que se quiere saber.
    const heartbeat = read("components/ui/presence-heartbeat.tsx");
    expect(heartbeat).toContain("document.hidden");
    expect(heartbeat).toContain("visibilitychange");
  });

  it("el userId del latido sale de la sesión, nunca del cliente", () => {
    const action = read("lib/actions/presence.ts");
    expect(action).toContain("session.data.userId");
    // La action no recibe parámetros: no hay forma de latir por otra persona.
    expect(action).toMatch(
      /export async function presenceHeartbeatAction\(\s*\)/,
    );
  });
});
