import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { readOrganizationOutboundOwner } from "@/lib/services/organization-outbound-owner";

/**
 * Dueño por defecto del pipeline Outbound.
 *
 * El ancla es un `membership_id` en `organizations.config.outbound`, igual
 * que el Customer Success de Post-venta: cambiar de persona es un UPDATE, no
 * un deploy.
 */

const ID = "11111111-1111-1111-1111-111111111111";

describe("readOrganizationOutboundOwner", () => {
  it("lee el ancla configurada", () => {
    expect(
      readOrganizationOutboundOwner({
        outbound: { default_owner_membership_id: ID },
      }),
    ).toBe(ID);
  });

  it("sin configurar devuelve null, que es un resultado válido", () => {
    // Una organización que no usa Outbound no tiene por qué configurar dueño.
    for (const config of [null, undefined, {}, { outbound: {} }]) {
      expect(readOrganizationOutboundOwner(config as never)).toBeNull();
    }
  });

  it("un valor basura no se propaga como id", () => {
    // Un id inventado llegaría a `createLead`, que lo rechaza y tumbaría la
    // creación del lead entera. Mejor null y que caiga al siguiente escalón.
    for (const malo of [42, true, [], {}, "", "   "]) {
      expect(
        readOrganizationOutboundOwner({
          outbound: { default_owner_membership_id: malo },
        } as never),
      ).toBeNull();
    }
  });

  it("una config con forma inesperada no truena", () => {
    for (const config of [[], "texto", 7, { outbound: "texto" }, { outbound: [] }]) {
      expect(() => readOrganizationOutboundOwner(config as never)).not.toThrow();
    }
  });
});

describe("contrato: las DOS vías de creación asignan dueño", () => {
  const ROOT = path.resolve(__dirname, "..");
  const read = (rel: string) => readFileSync(path.resolve(ROOT, rel), "utf8");

  it("ninguna crea ya con el asesor cableado a null", () => {
    // Era el bug: 85 de 90 tarjetas de Outbound nacían "Sin asignar" porque
    // ambas vías pasaban `advisorId: null` a mano. Arreglar una sola habría
    // dejado la mitad igual.
    for (const file of ["lib/actions/outbound.ts", "lib/actions/leads.ts"]) {
      const src = read(file);
      const outboundCreate = src.includes('channel: "outbound"');
      expect(outboundCreate, `${file} ya no crea en outbound`).toBe(true);
      expect(src).toContain("resolveOutboundOwner");
      expect(src).toContain("assignment: { mode: \"explicit\", advisorId: ownerId }");
    }
  });

  it("el resolver valida contra asesores ACTIVOS, no contra el rol", () => {
    // Filtrar por `role` rompería el invariante de la ranura (0050): un SDR
    // que opera cartera la tiene encendida, y un vendedor dado de baja no.
    const src = read("lib/services/outbound-owner.ts");
    expect(src).toContain("listActiveRealVendors");
    expect(src).not.toMatch(/role\s*===/);
  });
});
