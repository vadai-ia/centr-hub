import { describe, expect, it } from "vitest";
import { groupTagsByVendor, hasDuplicateVariants } from "@/lib/format/tag-grouping";
import type { TagMappingView } from "@/lib/types/admin";

/**
 * Agrupación de tags por vendedor (M2v2 #3).
 *
 * El caso real que la motivó: una vendedora acumuló tres variantes de su tag
 * en Shopify ("GinaJiménez", "Gina", "Gina Jiménez"). Las tres normalizan
 * distinto (trim + lowercase NO colapsa espacios interiores), así que son
 * tres filas de tag_mappings — y en lista plana parecían tres atribuciones
 * separadas, cuando en realidad las tres ya apuntaban a la misma persona.
 */

function tag(over: Partial<TagMappingView> & { normalized: string }): TagMappingView {
  return {
    original: over.normalized,
    count: 0,
    classification: "vendor",
    mapped_membership_id: null,
    mapped_vendor_name: null,
    mapped_vendor_active: null,
    ...over,
  };
}

const GINA = "m-gina";
const PEPE = "m-pepe";

describe("groupTagsByVendor", () => {
  it("junta las variantes de un mismo vendedor en un solo grupo y suma el total", () => {
    const groups = groupTagsByVendor([
      tag({ normalized: "ginajiménez", count: 198, mapped_membership_id: GINA, mapped_vendor_name: "Gina Jiménez" }),
      tag({ normalized: "gina", count: 52, mapped_membership_id: GINA, mapped_vendor_name: "Gina Jiménez" }),
      tag({ normalized: "gina jiménez", count: 1, mapped_membership_id: GINA, mapped_vendor_name: "Gina Jiménez" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].vendorName).toBe("Gina Jiménez");
    expect(groups[0].tags).toHaveLength(3);
    expect(groups[0].totalCount).toBe(251);
  });

  it("NO pierde ninguna variante al agrupar (borrarlas rompería la atribución futura)", () => {
    // Invariante central: agrupar es presentación. Las tres tags siguen
    // existiendo en Shopify y seguirán llegando en pedidos nuevos.
    const input = [
      tag({ normalized: "gina", count: 52, mapped_membership_id: GINA, mapped_vendor_name: "Gina" }),
      tag({ normalized: "ginajiménez", count: 198, mapped_membership_id: GINA, mapped_vendor_name: "Gina" }),
    ];
    const groups = groupTagsByVendor(input);
    const salidas = groups.flatMap((g) => g.tags.map((t) => t.normalized)).sort();
    expect(salidas).toEqual(["gina", "ginajiménez"]);
  });

  it("ordena las variantes por uso: la forma canónica queda primero", () => {
    const groups = groupTagsByVendor([
      tag({ normalized: "gina jiménez", count: 1, mapped_membership_id: GINA, mapped_vendor_name: "Gina" }),
      tag({ normalized: "ginajiménez", count: 198, mapped_membership_id: GINA, mapped_vendor_name: "Gina" }),
      tag({ normalized: "gina", count: 52, mapped_membership_id: GINA, mapped_vendor_name: "Gina" }),
    ]);
    expect(groups[0].tags.map((t) => t.count)).toEqual([198, 52, 1]);
  });

  it("ordena los grupos por total de entidades descendente", () => {
    const groups = groupTagsByVendor([
      tag({ normalized: "pepe", count: 88, mapped_membership_id: PEPE, mapped_vendor_name: "Pepe" }),
      tag({ normalized: "gina", count: 150, mapped_membership_id: GINA, mapped_vendor_name: "Gina" }),
      tag({ normalized: "ginajiménez", count: 101, mapped_membership_id: GINA, mapped_vendor_name: "Gina" }),
    ]);
    expect(groups.map((g) => g.vendorName)).toEqual(["Gina", "Pepe"]);
  });

  it("las tags informativas NO se agrupan entre sí: cada una es su propio renglón", () => {
    // No comparten sujeto. Juntarlas ("Factura" con "Anticipo 50%")
    // insinuaría una relación que no existe.
    const groups = groupTagsByVendor([
      tag({ normalized: "factura", count: 30, classification: "informational" }),
      tag({ normalized: "anticipo 50%", count: 12, classification: "informational" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.membershipId === null)).toBe(true);
  });

  it("una tag clasificada de vendedor pero SIN membership no se agrupa con otras sueltas", () => {
    const groups = groupTagsByVendor([
      tag({ normalized: "huerfana-1", count: 3, mapped_membership_id: null }),
      tag({ normalized: "huerfana-2", count: 5, mapped_membership_id: null }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("propaga el mapeo inactivo del vendedor al grupo", () => {
    const groups = groupTagsByVendor([
      tag({
        normalized: "exvendedor",
        count: 9,
        mapped_membership_id: "m-ex",
        mapped_vendor_name: "Ex Vendedor",
        mapped_vendor_active: false,
      }),
    ]);
    expect(groups[0].vendorActive).toBe(false);
  });

  it("lista vacía → sin grupos", () => {
    expect(groupTagsByVendor([])).toEqual([]);
  });
});

describe("hasDuplicateVariants", () => {
  it("solo marca a un vendedor con más de una variante", () => {
    const [conVarias] = groupTagsByVendor([
      tag({ normalized: "gina", count: 5, mapped_membership_id: GINA, mapped_vendor_name: "Gina" }),
      tag({ normalized: "ginajiménez", count: 5, mapped_membership_id: GINA, mapped_vendor_name: "Gina" }),
    ]);
    expect(hasDuplicateVariants(conVarias)).toBe(true);

    const [unaSola] = groupTagsByVendor([
      tag({ normalized: "pepe", count: 5, mapped_membership_id: PEPE, mapped_vendor_name: "Pepe" }),
    ]);
    expect(hasDuplicateVariants(unaSola)).toBe(false);
  });

  it("nunca marca una tag informativa, aunque quede sola en su grupo", () => {
    const [informativa] = groupTagsByVendor([
      tag({ normalized: "factura", count: 30, classification: "informational" }),
    ]);
    expect(hasDuplicateVariants(informativa)).toBe(false);
  });
});
