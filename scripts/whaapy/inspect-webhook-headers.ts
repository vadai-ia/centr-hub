/* eslint-disable no-console */
/**
 * Script de diagnóstico: leer `whaapy_raw_webhooks` y revelar
 * patrones de headers + body por delivery.
 *
 * Motivo: webhooks `contact.updated` caen sistemáticamente a
 * `exit_reason='dedup_hit'` aunque cada edit del contact en Whaapy
 * genere un payload distinto. Hipótesis: Whaapy reutiliza el header
 * `x-webhook-id` entre deliveries del mismo contact o entre eventos
 * del mismo ciclo (created + updated). El dedup key actual es
 * `dedup:whaapy:${topic}:${eventId}` con `eventId = x-webhook-id`.
 *
 * Esta tabla ya persiste TODOS los headers de cada request (columna
 * `headers` jsonb) — no se necesita instrumentación nueva, solo
 * leer y agrupar.
 *
 * Uso:
 *   npm run whaapy:inspect-webhook-headers -- [--limit 20] [--topic contact.updated]
 *
 * Output: para cada delivery imprime received_at, exit_reason,
 * topic, headers relevantes (x-webhook-*), contact_id del body,
 * y resumen final con cuántas filas comparten cada
 * (x-webhook-id, topic).
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

interface CliArgs {
  limit: number;
  topicFilter: string | null;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  let limit = 30;
  let topicFilter: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit") limit = Number(argv[++i] ?? "30");
    else if (arg === "--topic") topicFilter = argv[++i] ?? null;
  }
  return { limit, topicFilter };
}

interface RawWebhookRow {
  id: string;
  received_at: string;
  headers: Record<string, string> | null;
  body: Record<string, unknown> | null;
  endpoint: string | null;
  exit_reason: string | null;
}

function pickWebhookHeaders(headers: Record<string, string> | null): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (lower.startsWith("x-webhook") || lower === "x-request-id" || lower === "user-agent") {
      out[lower] = v;
    }
  }
  return out;
}

function extractTopicFromBody(body: Record<string, unknown> | null): string | null {
  if (!body) return null;
  const ev = body.event ?? body.topic;
  return typeof ev === "string" ? ev : null;
}

function extractContactIdFromBody(body: Record<string, unknown> | null): string | null {
  if (!body) return null;
  const data = body.data as Record<string, unknown> | undefined;
  if (!data) return null;
  const cid = data.contact_id;
  return typeof cid === "string" ? cid : null;
}

function extractUpdatedAtFromBody(body: Record<string, unknown> | null): string | null {
  if (!body) return null;
  const data = body.data as Record<string, unknown> | undefined;
  if (!data) return null;
  const ua = data.updated_at;
  return typeof ua === "string" ? ua : null;
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.log(`leyendo whaapy_raw_webhooks (endpoint='productive', limit=${args.limit}${args.topicFilter ? `, topic=${args.topicFilter}` : ""})`);

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("whaapy_raw_webhooks")
    .select("id, received_at, headers, body, endpoint, exit_reason")
    .eq("endpoint", "productive")
    .order("received_at", { ascending: false })
    .limit(args.limit);

  if (error) {
    console.error("query falló:", error.message);
    process.exit(1);
  }
  const rows = (data ?? []) as RawWebhookRow[];
  const filtered = args.topicFilter
    ? rows.filter((r) => extractTopicFromBody(r.body) === args.topicFilter)
    : rows;

  console.log(`filas totales: ${rows.length} (filtradas: ${filtered.length})`);
  console.log("");

  // Imprimir cronológicamente (más viejo arriba) para ver el orden de entrega.
  const ordered = [...filtered].reverse();

  for (const row of ordered) {
    const whHeaders = pickWebhookHeaders(row.headers);
    const topic = extractTopicFromBody(row.body);
    const contactId = extractContactIdFromBody(row.body);
    const updatedAt = extractUpdatedAtFromBody(row.body);
    console.log(`----- ${row.received_at} -----`);
    console.log(`  raw_id:       ${row.id}`);
    console.log(`  exit_reason:  ${row.exit_reason ?? "(null)"}`);
    console.log(`  body.event:   ${topic ?? "(none)"}`);
    console.log(`  contact_id:   ${contactId ?? "(none)"}`);
    console.log(`  updated_at:   ${updatedAt ?? "(none)"}`);
    console.log(`  webhook headers:`);
    for (const [k, v] of Object.entries(whHeaders)) {
      console.log(`    ${k}: ${v}`);
    }
    console.log("");
  }

  // Agrupar por x-webhook-id para revelar reutilización.
  const groups = new Map<string, RawWebhookRow[]>();
  for (const row of filtered) {
    const id = row.headers?.["x-webhook-id"] ?? "(missing)";
    const list = groups.get(id) ?? [];
    list.push(row);
    groups.set(id, list);
  }

  console.log("===== AGRUPACIÓN POR x-webhook-id =====");
  for (const [id, list] of Array.from(groups.entries())) {
    const topics = Array.from(new Set(list.map((r: RawWebhookRow) => extractTopicFromBody(r.body) ?? "(none)")));
    const contacts = Array.from(new Set(list.map((r: RawWebhookRow) => extractContactIdFromBody(r.body) ?? "(none)")));
    const exits = list.map((r: RawWebhookRow) => r.exit_reason ?? "(null)");
    console.log(`x-webhook-id=${id}`);
    console.log(`  count:     ${list.length}`);
    console.log(`  topics:    ${topics.join(", ")}`);
    console.log(`  contacts:  ${contacts.join(", ")}`);
    console.log(`  exits:     ${exits.join(", ")}`);
    console.log("");
  }

  // Agrupar también por (topic, x-webhook-id) — esto refleja exactamente la key Redis.
  const topicGroups = new Map<string, RawWebhookRow[]>();
  for (const row of filtered) {
    const topic = extractTopicFromBody(row.body) ?? "(none)";
    const id = row.headers?.["x-webhook-id"] ?? "(missing)";
    const key = `${topic}|${id}`;
    const list = topicGroups.get(key) ?? [];
    list.push(row);
    topicGroups.set(key, list);
  }

  console.log("===== AGRUPACIÓN POR (topic, x-webhook-id) — espejo de la dedup key =====");
  const collisions = Array.from(topicGroups.entries()).filter(([, list]) => list.length > 1);
  if (collisions.length === 0) {
    console.log("(sin colisiones — cada combinación topic+x-webhook-id es única)");
  } else {
    for (const [key, list] of collisions) {
      console.log(`${key}  →  ${list.length} deliveries`);
      for (const r of list) {
        const exits = r.exit_reason ?? "(null)";
        console.log(`    ${r.received_at}  exit=${exits}  contact=${extractContactIdFromBody(r.body) ?? "(none)"}  updated_at=${extractUpdatedAtFromBody(r.body) ?? "(none)"}`);
      }
      console.log("");
    }
  }
}

main().catch((err: Error) => {
  console.error("inspect-webhook-headers falló:", err.message);
  process.exit(1);
});
