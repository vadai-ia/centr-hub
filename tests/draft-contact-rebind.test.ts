import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DRAFT_CONTACT_REBOUND_EVENT } from "@/lib/constants";

/**
 * Si al borrador le cambian el CLIENTE en Shopify, la tarjeta lo sigue.
 *
 * El vendedor duplica una cotización y le pone otra persona. Shopify SÍ manda
 * `draft_orders/update` (verificado en los webhooks crudos), pero el worker
 * solo parcheaba montos, nota y dirección: la tarjeta se quedaba con el
 * cliente ANTERIOR mientras Shopify mostraba al correcto, y la misma
 * cotización aparecía a nombre de quien ya no era. Medido en Centr: 4
 * cotizaciones activas con el cliente equivocado.
 *
 * Esto es invisible para `tsc` y para la suite mockeada —el patch es un
 * `Record<string, unknown>`—, así que el guard lee la fuente.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

describe("draft_orders/update re-apunta el contacto", () => {
  const worker = read("lib/inngest/functions/draft-orders.ts");
  const updatePath = worker.slice(worker.indexOf("export const draftOrdersUpdate"));

  it("resuelve el contacto que viene en el payload", () => {
    expect(
      updatePath.includes("resolveOrCreateContactForDraftOrder"),
      "el path de update debe resolver el cliente del payload, no solo montos",
    ).toBe(true);
  });

  it("incluye contact_id en el patch de la oportunidad", () => {
    expect(
      /patch\.contact_id\s*=/.test(updatePath),
      "sin esto la tarjeta se queda con el cliente anterior",
    ).toBe(true);
  });

  it("deja rastro en la bitácora con el evento compartido", () => {
    expect(updatePath.includes("DRAFT_CONTACT_REBOUND_EVENT")).toBe(true);
    expect(worker.includes('from "@/lib/constants"')).toBe(true);
  });

  it("absorbe el Lead nuevo del contacto que RECIBE la cotización", () => {
    // La cotización aterriza en alguien que puede traer su propio lead
    // abierto: se archiva igual que cuando la cotización nace.
    expect(updatePath.includes('trigger: "draft_order_contact_rebound"')).toBe(true);
    const absorption = read("lib/services/opportunity-absorption.ts");
    expect(absorption.includes('"draft_order_contact_rebound"')).toBe(true);
  });
});

describe("el correctivo habla el mismo idioma que el worker", () => {
  const script = read("scripts/maintenance/rebind-draft-contacts.ts");

  it("emite el MISMO evento de auditoría, importado de constants", () => {
    expect(script.includes("DRAFT_CONTACT_REBOUND_EVENT")).toBe(true);
    expect(script.includes('from "@/lib/constants"')).toBe(true);
    expect(DRAFT_CONTACT_REBOUND_EVENT).toBe("opportunity_contact_rebound_from_draft");
  });

  it("no toca cotizaciones que ya tienen pedido ligado", () => {
    // Ahí manda la orden (su worker ya re-apunta el contacto); mover la
    // cotización rompería esa cadena.
    expect(script.includes("opp.shopify_order_id")).toBe(true);
  });

  it("no inventa contactos que todavía no existen en el CRM", () => {
    // Crearlos aquí los dejaría a medias (sin teléfono ni identidades):
    // eso es trabajo del webhook de customers/*.
    expect(script.includes("skippedNoContact")).toBe(true);
  });

  it("es dry-run salvo --apply explícito", () => {
    expect(script.includes('process.argv.includes("--apply")')).toBe(true);
  });
});
