import { describe, expect, it } from "vitest";
import {
  reconcileContactFields,
  type FieldProposal,
} from "@/lib/services/last-write-wins";
import type { ContactRow, Json } from "@/lib/types/database";

function makeContact(overrides: Partial<ContactRow> = {}): ContactRow {
  return {
    id: "c1",
    organization_id: "o1",
    full_name: "Antiguo",
    email: "antiguo@example.com",
    phone: "+525500000000",
    address: null,
    internal_note: "",
    shopify_tags: [],
    shopify_state: null,
    assigned_advisor_id: null,
    shopify_customer_id: null,
    whaapy_contact_id: null,
    field_metadata: {} as Json,
    last_modified_at: "2026-01-01T00:00:00Z",
    last_modified_source: "shopify",
    missing_phone: false,
    deleted_in_shopify: false,
    deleted_in_whaapy: false,
    anonymized_at: null,
    last_whaapy_activity_at: null,
    is_outbound: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("reconcileContactFields — R3 LWW por campo", () => {
  it("primer valor para un campo se aplica (sin metadata previa)", () => {
    const contact = makeContact();
    const proposals: FieldProposal[] = [
      { field: "full_name", value: "Nuevo", updatedAt: "2026-05-01T00:00:00Z", source: "shopify" },
    ];
    const result = reconcileContactFields(contact, proposals);
    expect(result.patch.full_name).toBe("Nuevo");
    expect(result.decisions[0].reason).toBe("first_value");
  });

  it("update con timestamp posterior se aplica", () => {
    const contact = makeContact({
      field_metadata: {
        full_name: { updated_at: "2026-01-01T00:00:00Z", source: "shopify" },
      } as Json,
    });
    const proposals: FieldProposal[] = [
      { field: "full_name", value: "MásNuevo", updatedAt: "2026-05-01T00:00:00Z", source: "whaapy" },
    ];
    const result = reconcileContactFields(contact, proposals);
    expect(result.patch.full_name).toBe("MásNuevo");
    expect(result.decisions[0].reason).toBe("newer");
  });

  it("update con timestamp anterior es ignorado (orden cronológico)", () => {
    const contact = makeContact({
      field_metadata: {
        full_name: { updated_at: "2026-05-01T00:00:00Z", source: "shopify" },
      } as Json,
    });
    const proposals: FieldProposal[] = [
      { field: "full_name", value: "Viejo", updatedAt: "2026-04-01T00:00:00Z", source: "whaapy" },
    ];
    const result = reconcileContactFields(contact, proposals);
    expect(result.patch.full_name).toBeUndefined();
    expect(result.decisions[0].reason).toBe("older_ignored");
  });

  it("borrado intencional propagado (campo vacío en update reciente SOBRESCRIBE)", () => {
    // R3: cuando un campo TIENE valor y llega una propuesta vacía
    // MÁS RECIENTE, el campo se borra (el usuario lo limpió en la
    // fuente externa deliberadamente). Distinto al caso vacío→vacío,
    // que no escribe metadata (ver bloque "anti-sealing" abajo).
    const contact = makeContact({
      internal_note: "VIP cliente",
      field_metadata: {
        internal_note: { updated_at: "2026-01-01T00:00:00Z", source: "shopify" },
      } as Json,
    });
    const proposals: FieldProposal[] = [
      { field: "internal_note", value: "", updatedAt: "2026-05-01T00:00:00Z", source: "whaapy" },
    ];
    const result = reconcileContactFields(contact, proposals);
    expect(result.patch.internal_note).toBe(null);
    expect(result.decisions[0].reason).toBe("empty_overwrite");
  });

  it("granularidad por campo: un campo más viejo y otro más nuevo en el mismo payload", () => {
    const contact = makeContact({
      field_metadata: {
        full_name: { updated_at: "2026-05-01T00:00:00Z", source: "whaapy" }, // ya nuevo
        email: { updated_at: "2026-01-01T00:00:00Z", source: "shopify" },     // viejo
      } as Json,
    });
    const proposals: FieldProposal[] = [
      { field: "full_name", value: "GanaWhaapy", updatedAt: "2026-04-01T00:00:00Z", source: "shopify" },
      { field: "email", value: "mas-nuevo@x.com", updatedAt: "2026-05-01T00:00:00Z", source: "shopify" },
    ];
    const result = reconcileContactFields(contact, proposals);
    expect(result.patch.full_name).toBeUndefined(); // ignorado, Whaapy ya tenía más nuevo
    expect(result.patch.email).toBe("mas-nuevo@x.com");
  });

  it("excepción match inicial (Shopify gana pero vacío NO borra)", () => {
    const contact = makeContact({
      full_name: "ValorMaestro",
      field_metadata: {
        full_name: { updated_at: "2025-12-01T00:00:00Z", source: "whaapy" },
      } as Json,
    });
    const proposals: FieldProposal[] = [
      // valor vacío: NO debe borrar
      { field: "full_name", value: "", updatedAt: "2026-05-01T00:00:00Z", source: "shopify" },
      // valor no-vacío: sí debe aplicar
      { field: "email", value: "shopify@x.com", updatedAt: "2026-05-01T00:00:00Z", source: "shopify" },
    ];
    const result = reconcileContactFields(contact, proposals, { isInitialMatch: true });
    expect(result.patch.full_name).toBeUndefined(); // preservado
    expect(result.patch.email).toBe("shopify@x.com");
    expect(result.decisions[0].reason).toBe("initial_match_preserve_value");
    expect(result.decisions[1].reason).toBe("initial_match_shopify_priority");
  });

  it("identificadores externos NUNCA se sobrescriben por LWW", () => {
    const contact = makeContact({ shopify_customer_id: "999" });
    const proposals: FieldProposal[] = [
      {
        field: "shopify_customer_id" as never,
        value: null,
        updatedAt: "2026-05-01T00:00:00Z",
        source: "shopify",
      },
    ];
    const result = reconcileContactFields(contact, proposals);
    expect(result.decisions[0].reason).toBe("blocked_external_id");
    expect(result.patch.shopify_customer_id).toBeUndefined();
  });

  it("shopify_tags [] sobre [] no genera patch ni sella metadata (fix LWW empty-sealing)", () => {
    // Regresión compuesta:
    // 1. (original — CHECKPOINT M4, customer 10100735082772) UPDATE
    //    con shopify_tags=null viola text[] NOT NULL en contacts.
    //    Cubierto: patch.shopify_tags es undefined, no se intenta
    //    NULL. El contact ya tiene [] desde createContact.
    // 2. (anti-sealing) NO se escribe metadata.shopify_tags para
    //    un par vacío-sobre-vacío — esa metadata bloquearía un
    //    UPDATE futuro con tags reales si el updated_at coincide.
    const contact = makeContact({ shopify_tags: [] });
    const proposals: FieldProposal[] = [
      { field: "shopify_tags", value: [], updatedAt: "2026-05-01T00:00:00Z", source: "shopify" },
    ];
    const result = reconcileContactFields(contact, proposals);
    expect(result.patch.shopify_tags).toBeUndefined();
    expect(
      (result.nextFieldMetadata as Record<string, unknown>).shopify_tags,
    ).toBeUndefined();
    expect(result.decisions[0].reason).toBe("noop_both_empty");
    expect(result.decisions[0].applied).toBe(false);
  });

  it("shopify_tags vacío en UPDATE sobrescribe con [] (no null) aunque exista valor previo", () => {
    // Cuando un customer ya tiene tags ["Gina"] y un update llega
    // con tags vacíos (Shopify reporta 0 tags), debe quedar [] —
    // doctrina v5.1 "empty overwrites" + representación correcta
    // para columna text[] NOT NULL.
    const contact = makeContact({
      shopify_tags: ["Gina"],
      field_metadata: {
        shopify_tags: { updated_at: "2026-01-01T00:00:00Z", source: "shopify" },
      } as Json,
    });
    const proposals: FieldProposal[] = [
      { field: "shopify_tags", value: [], updatedAt: "2026-05-01T00:00:00Z", source: "shopify" },
    ];
    const result = reconcileContactFields(contact, proposals);
    expect(result.patch.shopify_tags).toEqual([]);
    expect(result.patch.shopify_tags).not.toBeNull();
    expect(result.decisions[0].reason).toBe("empty_overwrite");
  });

  describe("anti-sealing — fix bug LWW que sellaba campos vacíos", () => {
    it("phone null + propuesta null + sin meta previa → no patch, no meta", () => {
      // Stub recién creado por order/draft-order: field_metadata vacío.
      // Si llega una propuesta con phone=null (fuente no tiene phone),
      // NO debemos escribir metadata.phone. Si lo hiciéramos, una
      // propuesta futura con el mismo updated_at de Shopify quedaría
      // bloqueada como older_ignored aunque trajera un phone real.
      const contact = makeContact({
        phone: null,
        field_metadata: {} as Json,
      });
      const proposals: FieldProposal[] = [
        { field: "phone", value: null, updatedAt: "2026-05-01T00:00:00Z", source: "shopify" },
      ];
      const result = reconcileContactFields(contact, proposals);
      expect(result.patch.phone).toBeUndefined();
      expect(
        (result.nextFieldMetadata as Record<string, unknown>).phone,
      ).toBeUndefined();
      expect(result.decisions[0].applied).toBe(false);
      expect(result.decisions[0].reason).toBe("noop_both_empty");
    });

    it("phone null + propuesta null CON meta previa stale → meta NO se actualiza, queda intacta", () => {
      // Caso operativo de los 104 contactos: el campo YA quedó
      // sellado por una corrida pasada (mapper buggy). El reconciler
      // recibe una nueva propuesta vacía. Comportamiento correcto:
      // no re-sellar (no escribir meta nueva con updated_at más
      // reciente) y no tocar el patch. El desbloqueo es un paso
      // operativo aparte (SQL clear o re-fetch con updated_at
      // avanzado del lado de Shopify).
      const contact = makeContact({
        phone: null,
        field_metadata: {
          phone: { updated_at: "2026-04-01T00:00:00Z", source: "shopify" },
        } as Json,
      });
      const proposals: FieldProposal[] = [
        { field: "phone", value: null, updatedAt: "2026-05-01T00:00:00Z", source: "shopify" },
      ];
      const result = reconcileContactFields(contact, proposals);
      expect(result.patch.phone).toBeUndefined();
      // Meta vieja se PRESERVA tal cual (no avanza al timestamp nuevo).
      expect(
        (result.nextFieldMetadata as Record<string, unknown>).phone,
      ).toEqual({
        updated_at: "2026-04-01T00:00:00Z",
        source: "shopify",
      });
      expect(result.decisions[0].reason).toBe("noop_both_empty");
    });

    it("valor real más reciente sobre phone null + meta stale → SE aplica (re-fill funciona)", () => {
      // Confirma que la sección 'older_ignored' del LWW no quedó
      // afectada por el fix. Una propuesta con valor REAL y
      // updated_at más reciente sigue ganando sobre el stub vacío
      // sellado, igual que en el pre-fix.
      const contact = makeContact({
        phone: null,
        field_metadata: {
          phone: { updated_at: "2026-04-01T00:00:00Z", source: "shopify" },
        } as Json,
      });
      const proposals: FieldProposal[] = [
        { field: "phone", value: "+528115708848", updatedAt: "2026-05-01T00:00:00Z", source: "shopify" },
      ];
      const result = reconcileContactFields(contact, proposals);
      expect(result.patch.phone).toBe("+528115708848");
      expect(result.decisions[0].reason).toBe("newer");
    });

    it("anti-sealing aplica también dentro de match inicial (Shopify priority) cuando ambos vacíos", () => {
      // Match defensivo v5.1: contact local nacido en Whaapy sin
      // phone que se enlaza a un customer Shopify también sin phone.
      // Bajo isInitialMatch + source shopify, NO debemos sellar el
      // campo vacío — un edit posterior en cualquiera de los dos
      // sistemas debe poder rellenar phone sin chocar con LWW.
      const contact = makeContact({
        phone: null,
        field_metadata: {} as Json,
      });
      const proposals: FieldProposal[] = [
        { field: "phone", value: null, updatedAt: "2026-05-01T00:00:00Z", source: "shopify" },
      ];
      const result = reconcileContactFields(contact, proposals, { isInitialMatch: true });
      expect(result.patch.phone).toBeUndefined();
      expect(
        (result.nextFieldMetadata as Record<string, unknown>).phone,
      ).toBeUndefined();
      expect(result.decisions[0].reason).toBe("noop_both_empty");
    });

    it("R3 intacto: campo CON valor + propuesta vacía MÁS RECIENTE → empty_overwrite + meta avanza", () => {
      // Verifica explícitamente que el fix NO afecta R3 (borrados
      // intencionales propagados): un campo que TIENE valor y recibe
      // una propuesta vacía MÁS RECIENTE sigue siendo sobrescrito,
      // y la metadata se bump-ea al timestamp nuevo (para que un
      // valor viejo de otra fuente no pueda refile-arlo después).
      const contact = makeContact({
        internal_note: "VIP cliente",
        field_metadata: {
          internal_note: { updated_at: "2026-01-01T00:00:00Z", source: "shopify" },
        } as Json,
      });
      const proposals: FieldProposal[] = [
        { field: "internal_note", value: "", updatedAt: "2026-05-01T00:00:00Z", source: "whaapy" },
      ];
      const result = reconcileContactFields(contact, proposals);
      expect(result.patch.internal_note).toBe(null);
      expect(result.decisions[0].reason).toBe("empty_overwrite");
      expect(
        (result.nextFieldMetadata as Record<string, unknown>).internal_note,
      ).toEqual({
        updated_at: "2026-05-01T00:00:00Z",
        source: "whaapy",
      });
    });

    it("R3 intacto: campo CON valor + propuesta vacía MÁS VIEJA → older_ignored (no se borra)", () => {
      // Espejo del test anterior: una propuesta vacía con timestamp
      // MÁS VIEJO no debe borrar el valor existente. R3 sigue siendo
      // direccional (más nuevo gana, no "vacío siempre gana").
      const contact = makeContact({
        internal_note: "VIP cliente",
        field_metadata: {
          internal_note: { updated_at: "2026-05-01T00:00:00Z", source: "shopify" },
        } as Json,
      });
      const proposals: FieldProposal[] = [
        { field: "internal_note", value: "", updatedAt: "2026-01-01T00:00:00Z", source: "whaapy" },
      ];
      const result = reconcileContactFields(contact, proposals);
      expect(result.patch.internal_note).toBeUndefined();
      expect(result.decisions[0].reason).toBe("older_ignored");
    });
  });

  it("metadata se preserva campo por campo en el patch final", () => {
    const contact = makeContact({
      field_metadata: {
        existing: { updated_at: "2024-01-01T00:00:00Z", source: "platform" },
      } as Json,
    });
    const proposals: FieldProposal[] = [
      { field: "email", value: "z@x.com", updatedAt: "2026-05-01T00:00:00Z", source: "shopify" },
    ];
    const result = reconcileContactFields(contact, proposals);
    expect(result.nextFieldMetadata).toMatchObject({
      existing: { updated_at: "2024-01-01T00:00:00Z", source: "platform" },
      email: { updated_at: "2026-05-01T00:00:00Z", source: "shopify" },
    });
  });
});
