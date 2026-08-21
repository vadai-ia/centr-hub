/* eslint-disable no-console */
/**
 * Diagnóstico (lectura pura): revela el `businessId` de una instancia de
 * Whaapy a partir de su api_key, y lo compara con el que la org tiene
 * guardado en `organizations`.
 *
 * Por qué existe: el `businessId` es el discriminador que resuelve la
 * organización en cada webhook entrante, pero Whaapy NO tiene endpoint para
 * consultarlo — viaja en la RAÍZ del payload de los webhooks (ver
 * `extractBusinessId` en `lib/whaapy/mappers.ts`). Hasta ahora la única forma
 * de conocerlo era esperar a que llegara un webhook real. `GET /user-webhooks`
 * lo expone como campo NO documentado de cada webhook registrado, lo que
 * permite obtenerlo antes de recibir el primer evento — justo lo que hace
 * falta al dar de alta una org nueva.
 *
 * Invariante de los scripts inspect-*: NO escribe a BD propia, NO modifica
 * nada en Whaapy. Además, el response de `/user-webhooks` incluye el `secret`
 * HMAC en claro: aquí se REDACTA a sus últimos 4 (nunca imprimir un secreto).
 *
 * Uso:
 *   npm run whaapy:inspect-business-id -- --org-slug rustr --provider postventa
 *   npm run whaapy:inspect-business-id -- --org-slug centr --provider venta
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { getWhaapyApiKey, getWhaapyPostventaApiKey } from "@/lib/vault";
import { WHAAPY_API_BASE } from "@/lib/whaapy/config";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/** Últimos 4 de un secreto. Nunca se imprime el valor completo. */
function last4(v: unknown): string {
  return typeof v === "string" && v.length >= 4 ? `····${v.slice(-4)}` : "—";
}

interface WhaapyWebhook {
  id?: string;
  businessId?: string;
  name?: string;
  url?: string;
  events?: string[];
  secret?: string;
  isActive?: boolean;
  failureCount?: number;
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
}

async function main(): Promise<void> {
  const slug = arg("--org-slug");
  const provider = arg("--provider", "postventa");
  if (!slug || (provider !== "venta" && provider !== "postventa")) {
    console.error("Uso: --org-slug <slug> --provider venta|postventa");
    process.exit(1);
  }
  const org = await getOrganizationBySlug(slug);
  if (!org) {
    console.error(`org ${slug} no encontrada`);
    process.exit(1);
  }
  console.log(`org: ${org.name} (${org.id})`);
  console.log(`instancia: Whaapy ${provider === "venta" ? "Venta" : "Post-venta"}`);

  const apiKey =
    provider === "venta"
      ? await getWhaapyApiKey(org.id)
      : await getWhaapyPostventaApiKey(org.id);

  const res = await fetch(`${WHAAPY_API_BASE}/user-webhooks`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`GET /user-webhooks → HTTP ${res.status}: ${text.slice(0, 500)}`);
    process.exit(1);
  }
  const parsed = text ? (JSON.parse(text) as { data?: WhaapyWebhook[] }) : null;
  const hooks = Array.isArray(parsed?.data) ? parsed.data : [];

  console.log(`\n=== Webhooks registrados (${hooks.length}) ===`);
  for (const h of hooks) {
    console.log(`  "${h.name ?? "?"}"`);
    console.log(`    url          ${h.url ?? "—"}`);
    console.log(`    businessId   ${h.businessId ?? "—"}`);
    console.log(`    secret HMAC  ${last4(h.secret)}`);
    console.log(`    activo       ${h.isActive ?? "?"}  fallos=${h.failureCount ?? "?"}`);
    console.log(`    últ. éxito   ${h.lastSuccessAt ?? "nunca"}`);
    console.log(`    eventos      ${(h.events ?? []).length}`);
  }

  const found = Array.from(
    new Set(hooks.map((h) => h.businessId).filter((b): b is string => !!b)),
  );
  const stored =
    provider === "venta" ? org.whaapy_business_id : org.whaapy_postventa_business_id;

  console.log(`\n=== businessId ===`);
  console.log(`  guardado en organizations: ${stored ?? "— sin definir —"}`);
  if (found.length === 0) {
    console.log(`  reportado por Whaapy:      — ninguno (¿sin webhooks registrados?) —`);
  } else if (found.length === 1) {
    console.log(`  reportado por Whaapy:      ${found[0]}`);
    if (!stored) {
      console.log(`\n  ⚠ Falta capturarlo. Admin → Integraciones → editar "Business ID".`);
    } else if (stored !== found[0]) {
      console.log(`\n  ⚠ NO COINCIDEN. Los webhooks de esta instancia no resolverán la org.`);
    } else {
      console.log(`\n  OK: coincide.`);
    }
  } else {
    console.log(`  reportado por Whaapy:      ${found.join(", ")}`);
    console.log(`\n  ⚠ Más de un businessId: la api_key ve webhooks de varias cuentas.`);
  }
}

main().catch((err: Error) => {
  console.error("inspect-business-id falló:", err.message);
  process.exit(1);
});
