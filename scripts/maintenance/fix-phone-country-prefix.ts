/* eslint-disable no-console */
/**
 * Correctivo — teléfonos guardados con la lada de OTRO país.
 *
 * Los leads de una organización se normalizaban siempre con la lada de
 * México porque el país por defecto era una constante. Al corregirlo (la
 * lada sale ahora de `organizations.config.defaults.phone_country`) los leads
 * NUEVOS entran bien, pero los ya guardados quedaron con el prefijo
 * equivocado: un móvil colombiano `300 325 4649` se guardó como
 * `+523003254649` en vez de `+573003254649`. Con ese número no se le puede
 * escribir por WhatsApp y el cruce por teléfono no empata.
 *
 * Qué toca y qué NO:
 *   - Solo contactos cuyo teléfono empieza con la lada EQUIVOCADA y cuyos
 *     dígitos coinciden con un patrón de móvil REAL del país de la
 *     organización. Un número que no case con el patrón se reporta y no se
 *     toca: `libphonenumber` acepta como "válido en México" casi cualquier
 *     10 dígitos, así que la validez por sí sola no distingue nada.
 *   - **Las colisiones se SALTAN.** Si el número corregido ya existe como
 *     otro contacto, son dos fichas de la misma persona: re-escribir el
 *     teléfono crearía un duplicado exacto en vez de arreglar nada. Se
 *     listan para fusionarlas (`maintenance:merge-duplicate-leads`).
 *   - **No propaga a Shopify ni a Whaapy.** Los contactos enlazados se
 *     reportan aparte: cambiarles el teléfono aquí deja el externo
 *     desincronizado y eso se decide a mano.
 *
 * Uso:
 *   npm run maintenance:fix-phone-country-prefix -- --org-slug centr-colombia
 *   npm run maintenance:fix-phone-country-prefix -- --org-slug centr-colombia --apply
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { recordAuditEvent } from "@/lib/db/operational";
import { readOrganizationPhoneCountry } from "@/lib/services/organization-phone-country";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

/**
 * Lada y patrón de móvil por país. El patrón es lo que separa "número de otro
 * país mal prefijado" de "número legítimo": sin él, cualquier 10 dígitos
 * pasaría por mexicano.
 */
const PAIS: Record<string, { lada: string; movil: RegExp }> = {
  // Móviles colombianos: 3 + prefijo de operador asignado + 7 dígitos.
  CO: { lada: "+57", movil: /^3(0[0-5]|1[0-9]|2[0-4]|5[01])\d{7}$/ },
  MX: { lada: "+52", movil: /^\d{10}$/ },
};

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

async function main() {
  const slug = arg("org-slug");
  const apply = process.argv.includes("--apply");
  if (!slug) {
    console.error("Falta --org-slug");
    process.exit(1);
  }
  const org = await getOrganizationBySlug(slug);
  if (!org) {
    console.error(`No existe la organización "${slug}".`);
    process.exit(1);
  }

  const pais = readOrganizationPhoneCountry(org.config);
  const destino = PAIS[pais];
  if (!destino) {
    console.error(`Sin patrón de móvil para el país "${pais}". Agrégalo al script.`);
    process.exit(1);
  }
  // Las ladas equivocadas son todas las demás que el script conoce.
  const ladasMalas = Object.entries(PAIS)
    .filter(([k]) => k !== pais)
    .map(([, v]) => v.lada);

  const sb = getSupabaseAdminClient();
  const { data, error } = await sb
    .from("contacts")
    .select("id, full_name, phone, whaapy_contact_id, shopify_customer_id")
    .eq("organization_id", org.id)
    .not("phone", "is", null);
  if (error) throw error;
  type C = {
    id: string; full_name: string | null; phone: string;
    whaapy_contact_id: string | null; shopify_customer_id: string | null;
  };
  const rows = (data ?? []) as unknown as C[];
  const yaCorrectos = new Set(
    rows.filter((c) => c.phone.startsWith(destino.lada)).map((c) => c.phone),
  );

  const corregir: Array<{ c: C; nuevo: string }> = [];
  const colisiones: Array<{ c: C; nuevo: string }> = [];
  const sinPatron: C[] = [];
  const conExterno: Array<{ c: C; nuevo: string }> = [];

  for (const c of rows) {
    const mala = ladasMalas.find((l) => c.phone.startsWith(l));
    if (!mala) continue;
    const digitos = c.phone.slice(mala.length);
    if (!destino.movil.test(digitos)) {
      sinPatron.push(c);
      continue;
    }
    const nuevo = `${destino.lada}${digitos}`;
    if (yaCorrectos.has(nuevo)) {
      colisiones.push({ c, nuevo });
      continue;
    }
    if (c.whaapy_contact_id || c.shopify_customer_id) {
      conExterno.push({ c, nuevo });
      continue;
    }
    corregir.push({ c, nuevo });
  }

  console.log(`${slug} — país de la organización: ${pais} (${destino.lada})`);
  console.log(`  contactos con teléfono            : ${rows.length}`);
  console.log(`  a corregir                        : ${corregir.length}`);
  console.log(`  duplicados (el correcto ya existe): ${colisiones.length}  → fusionar, no renumerar`);
  console.log(`  enlazados a Shopify/Whaapy        : ${conExterno.length}  → decidir a mano (quedaría desincronizado)`);
  console.log(`  con lada ajena pero sin patrón    : ${sinPatron.length}  → revisar a mano`);

  for (const { c, nuevo } of corregir.slice(0, 8)) {
    console.log(`    ${c.phone} → ${nuevo}   ${c.full_name ?? "(sin nombre)"}`);
  }
  for (const { c, nuevo } of colisiones) {
    console.log(`    DUPLICADO ${c.phone} ↔ ${nuevo}   ${c.full_name ?? "(sin nombre)"}`);
  }
  for (const { c, nuevo } of conExterno) {
    console.log(`    EXTERNO   ${c.phone} → ${nuevo}   ${c.full_name ?? "(sin nombre)"}`);
  }
  for (const c of sinPatron) {
    console.log(`    SIN PATRÓN ${c.phone}   ${c.full_name ?? "(sin nombre)"}`);
  }

  if (!apply) {
    console.log("\n(dry-run — no se tocó nada). Repite con --apply.");
    return;
  }
  if (corregir.length === 0) return;

  let hechos = 0;
  await withTenantContext(
    org.id,
    async () => {
      for (const { c, nuevo } of corregir) {
        const ts = new Date().toISOString();
        const { error: updErr } = await sb
          .from("contacts")
          .update({
            phone: nuevo,
            missing_phone: false,
            last_modified_at: ts,
            last_modified_source: "platform",
          })
          .eq("id", c.id)
          .eq("organization_id", org.id)
          // Re-filtra por el valor leído: si alguien lo editó entre la
          // lectura y la escritura, su edición manda.
          .eq("phone", c.phone);
        if (updErr) throw updErr;
        hechos += 1;
        try {
          await recordAuditEvent({
            actorUserId: null,
            eventType: "contact_phone_country_prefix_fixed",
            entityType: "contact",
            entityId: c.id,
            payload: { from: c.phone, to: nuevo, country: pais },
          });
        } catch {
          // best-effort: la corrección ya quedó.
        }
      }
    },
    { source: "worker" },
  );
  console.log(`\nListo: ${hechos} teléfonos corregidos a ${destino.lada}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
