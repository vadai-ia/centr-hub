/* eslint-disable no-console */
/**
 * READ-ONLY — validación posterior a recrear el webhook de Whaapy.
 *
 * Por qué existe: Whaapy no permite editar un webhook; cualquier cambio obliga
 * a borrarlo y crearlo, y cada creación emite un secret HMAC nuevo que se
 * muestra UNA sola vez. Si el Vault no se actualiza en esa misma ventana,
 * TODO el inbound se descarta con `invalid_hmac` — y el síntoma es
 * indistinguible de "no ha pasado nada": HTTP 200 al proveedor y cero filas
 * nuevas. Ese diagnóstico costó 8+ iteraciones la primera vez (ver ERRORES.md
 * "Secret HMAC de Whaapy desactualizado en Vault tras recrear el webhook").
 *
 * El SOP de CLAUDE.md pide esta validación a mano, con SQL en el dashboard.
 * Esto la automatiza.
 *
 * Invariante de los scripts inspect/check-*: NO escribe nada, ni en la BD ni
 * en Whaapy. Los secretos se comparan pero NUNCA se imprimen (solo últimos 4).
 *
 * Uso:
 *   npm run whaapy:check-inbound-health -- --org-slug centr
 *   npm run whaapy:check-inbound-health -- --org-slug centr --hours 24
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { getWhaapyApiKey, getWhaapyWebhookSecret } from "@/lib/vault";
import { WHAAPY_API_BASE } from "@/lib/whaapy/config";
import { WHAAPY_SUBSCRIBED_TOPICS } from "@/lib/inngest/client";
import type { UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/** Nunca se imprime un secreto completo. */
function last4(v: unknown): string {
  return typeof v === "string" && v.length >= 4 ? `····${v.slice(-4)}` : "—";
}

interface WhaapyWebhook {
  name?: string;
  url?: string;
  businessId?: string;
  events?: string[];
  secret?: string;
  isActive?: boolean;
  failureCount?: number;
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
}

/** Los eventos que la plataforma sabe atender hoy. */
const ESPERADOS = WHAAPY_SUBSCRIBED_TOPICS;

/** Salidas del endpoint que significan "esto no entró y es un problema". */
const SALIDAS_MALAS = new Set([
  "invalid_hmac",
  "organization_not_found",
  "missing_secret",
  "missing_business_id",
  "enqueue_failed",
]);

async function main(): Promise<void> {
  const slug = arg("--org-slug");
  const hours = Number(arg("--hours", "24"));
  if (!slug || !Number.isFinite(hours) || hours <= 0) {
    console.error("Uso: --org-slug <slug> [--hours 24]");
    process.exit(1);
  }
  const org = await getOrganizationBySlug(slug);
  if (!org) {
    console.error(`org ${slug} no encontrada`);
    process.exit(1);
  }
  console.log(`org: ${org.name} (${org.id})`);
  console.log(`instancia: Whaapy Venta\n`);

  let problemas = 0;

  // ---------------------------------------------------------------
  // 1) El webhook vivo y su secret, si la api_key alcanza a verlo.
  // ---------------------------------------------------------------
  const apiKey = await getWhaapyApiKey(org.id as UUID);
  const res = await fetch(`${WHAAPY_API_BASE}/user-webhooks`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  const text = await res.text();

  // La comparación de secretos necesita el scope `webhooks:read`, que la
  // api_key puede no tener. No es motivo para abortar: lo que de verdad urge
  // tras recrear el webhook es ver qué pasó con los eventos que llegaron, y
  // eso sale de la BD.
  let sinScope = false;
  if (!res.ok) {
    if (res.status === 403 && text.includes("webhooks:read")) {
      sinScope = true;
    } else {
      console.error(`GET /user-webhooks → HTTP ${res.status}: ${text.slice(0, 300)}`);
      process.exit(1);
    }
  }
  const parsed =
    !sinScope && text ? (JSON.parse(text) as { data?: WhaapyWebhook[] }) : null;
  const hooks = Array.isArray(parsed?.data) ? parsed.data : [];

  let vaultSecret: string | null = null;
  try {
    vaultSecret = await getWhaapyWebhookSecret(org.id as UUID);
  } catch {
    vaultSecret = null;
  }

  console.log(`=== Webhook registrado en Whaapy ===`);
  if (sinScope) {
    console.log(
      `  No se puede consultar: la api_key no tiene el scope 'webhooks:read'.\n` +
        `  Para habilitarlo hay que regenerar la api_key con ese scope y rotarla en\n` +
        `  el Vault. Mientras tanto el veredicto sale del ingreso real (abajo):\n` +
        `  'invalid_hmac' significa que el secret del Vault no es el del webhook.`,
    );
  } else {
    if (hooks.length === 0) {
      console.log("  ⚠ Ninguno registrado. Nada va a entrar.");
      problemas++;
    }
    for (const h of hooks) {
      console.log(`  "${h.name ?? "?"}"`);
      console.log(`    url         ${h.url ?? "—"}`);
      console.log(`    activo      ${h.isActive ?? "?"}   fallos=${h.failureCount ?? "?"}`);
      console.log(`    últ. éxito  ${h.lastSuccessAt ?? "nunca"}`);
      console.log(`    últ. fallo  ${h.lastFailureAt ?? "nunca"}`);
      console.log(`    secret      ${last4(h.secret)}`);

      if (!h.url?.endsWith("/api/webhooks/whaapy")) {
        console.log(`    ⚠ La URL no termina en /api/webhooks/whaapy.`);
        problemas++;
      }
      const suscritos = new Set(h.events ?? []);
      const faltantes = ESPERADOS.filter((e) => !suscritos.has(e));
      console.log(`    eventos     ${suscritos.size} suscritos`);
      if (faltantes.length > 0) {
        console.log(`    ⚠ NO suscritos (la plataforma los atiende): ${faltantes.join(", ")}`);
        problemas++;
      }
    }
  }

  console.log(`\n=== Secret HMAC en el Vault ===`);
  console.log(`  Vault       ${last4(vaultSecret)}`);
  if (!vaultSecret) {
    console.log(`  ⚠ El Vault NO tiene webhook_secret. Todo el inbound se descarta.`);
    problemas++;
  } else if (sinScope) {
    console.log(`  (sin 'webhooks:read' no se puede comparar con el webhook activo)`);
  } else if (hooks.length > 0) {
    // Comparación por valor completo; se reporta solo el veredicto.
    if (hooks.some((h) => h.secret === vaultSecret)) {
      console.log(`  OK: coincide con el webhook activo.`);
    } else {
      console.log(
        `  ⚠ NO COINCIDE con ningún webhook activo. El inbound se descarta con\n` +
          `    'invalid_hmac'. El secret no se puede volver a ver en el dashboard:\n` +
          `    si ya se perdió, hay que recrear el webhook otra vez.`,
      );
      problemas++;
    }
  }

  // ---------------------------------------------------------------
  // 2) Qué pasó con los eventos que SÍ llegaron.
  // ---------------------------------------------------------------
  await withTenantContext(
    org.id as UUID,
    async () => {
      const desde = new Date(Date.now() - hours * 3600_000).toISOString();
      const supabase = getSupabaseAdminClient();

      const { data: raws, error } = await supabase
        .from("whaapy_raw_webhooks")
        .select("exit_reason, body, received_at")
        .eq("endpoint", "productive")
        .gte("received_at", desde)
        .order("received_at", { ascending: false });
      if (error) throw error;

      const filas = raws ?? [];
      console.log(`\n=== Ingreso de las últimas ${hours} h (${filas.length} requests) ===`);
      if (filas.length === 0) {
        console.log(`  Ninguna. O no hubo actividad, o el webhook no apunta aquí.`);
      }

      const porSalida = new Map<string, number>();
      const porEvento = new Map<string, number>();
      for (const r of filas) {
        const salida = (r as { exit_reason: string | null }).exit_reason ?? "(sin marcar)";
        porSalida.set(salida, (porSalida.get(salida) ?? 0) + 1);
        const body = (r as { body: { event?: string; topic?: string } | null }).body;
        const ev = body?.event ?? body?.topic ?? "(sin evento)";
        porEvento.set(ev, (porEvento.get(ev) ?? 0) + 1);
      }

      if (porSalida.size > 0) {
        console.log(`\n  Por resultado:`);
        for (const [k, v] of Array.from(porSalida.entries()).sort((a, b) => b[1] - a[1])) {
          const mal = SALIDAS_MALAS.has(k);
          console.log(`   ${mal ? "⚠" : " "} ${k.padEnd(24)} ${v}`);
          if (mal) problemas++;
        }
        console.log(`\n  Por evento:`);
        for (const [k, v] of Array.from(porEvento.entries()).sort((a, b) => b[1] - a[1])) {
          console.log(`     ${k.padEnd(24)} ${v}`);
        }
      }

      // -------------------------------------------------------------
      // 3) ¿Aterrizaron mensajes? (0058)
      // -------------------------------------------------------------
      const { count, error: e2 } = await supabase
        .from("whaapy_messages")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org.id);
      if (e2) throw e2;

      const { data: ultimo } = await supabase
        .from("whaapy_messages")
        .select("occurred_at, direction, sent_by_ai")
        .eq("organization_id", org.id)
        .order("occurred_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      console.log(`\n=== Mensajes registrados (0058) ===`);
      console.log(`  total        ${count ?? 0}`);
      if (ultimo) {
        const u = ultimo as { occurred_at: string; direction: string; sent_by_ai: boolean };
        console.log(
          `  último       ${u.occurred_at}  (${u.direction}${u.sent_by_ai ? ", del bot" : ""})`,
        );
      } else {
        console.log(
          `  Todavía ninguno. Es NORMAL si acabas de suscribir los eventos: la tabla\n` +
            `  arranca vacía y se llena con la conversación de aquí en adelante.`,
        );
      }
    },
    { source: "script" },
  );

  console.log(
    problemas === 0
      ? `\nSin problemas detectados.`
      : `\n${problemas} problema(s) detectado(s) — ver las líneas con ⚠ arriba.`,
  );
}

main().catch((err: Error) => {
  console.error("check-inbound-health falló:", err.message);
  process.exit(1);
});
