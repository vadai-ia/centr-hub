import "server-only";
import { whaapyRest, type WhaapyClientContext } from "@/lib/whaapy/admin-client";

/**
 * Lectura del EQUIPO (agentes humanos) del Whaapy de Venta — `GET /team/v1`
 * (scope `team:*`, ya activado). Alimenta el mapeo `memberships.whaapy_agent_id`
 * (Track 2 / Bloque C): sin ese mapeo, ni la asignación inbound
 * (`conversation.assigned`) ni el `assigned_agent_id` outbound funcionan.
 *
 * La forma EXACTA de la response de `/team/v1` no está confirmada contra una
 * captura real (el MCP de doc de Whaapy no estaba disponible al construir esto),
 * así que el parser es TOLERANTE: acepta array plano o envuelto en varias
 * llaves comunes, y extrae id/nombre/email probando alias. Confirmar la forma
 * real con `npm run whaapy:inspect-team` y, si difiere, endurecer aquí.
 * La UI de mapeo ofrece además captura MANUAL del id como red por si el parser
 * no acierta con la forma real.
 */

export interface WhaapyAgent {
  id: string;
  name: string | null;
  email: string | null;
}

function pickString(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

/** Extrae el array de agentes de las formas de response conocidas/probables. */
function pickAgentArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  const o = raw as Record<string, unknown>;
  const KEYS = ["team", "agents", "members", "users", "data", "results"];
  for (const k of KEYS) {
    if (Array.isArray(o[k])) return o[k] as unknown[];
  }
  // Un nivel de anidación: { data: { team: [...] } }.
  const inner = o.data;
  if (inner && typeof inner === "object") {
    const io = inner as Record<string, unknown>;
    for (const k of ["team", "agents", "members", "users"]) {
      if (Array.isArray(io[k])) return io[k] as unknown[];
    }
  }
  return [];
}

/** Parser puro (testeable sin red). Descarta items sin id resoluble. */
export function parseWhaapyTeamResponse(raw: unknown): WhaapyAgent[] {
  const arr = pickAgentArray(raw);
  const out: WhaapyAgent[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = pickString(o, ["id", "agent_id", "agentId", "uuid", "_id", "user_id", "userId"]);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = pickString(o, ["name", "full_name", "fullName", "display_name", "displayName"]);
    const email = pickString(o, ["email", "email_address", "emailAddress"]);
    out.push({ id, name, email });
  }
  return out;
}

export async function listWhaapyTeam(ctx: WhaapyClientContext): Promise<WhaapyAgent[]> {
  const raw = await whaapyRest<unknown>(ctx, "GET", "/team/v1");
  return parseWhaapyTeamResponse(raw);
}
