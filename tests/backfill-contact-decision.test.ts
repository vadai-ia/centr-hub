import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  decideBackfillContactAction,
  resolveEffectivePhone,
  computePlaceholderPhones,
} from "@/lib/services/backfill-contact-decision";

/**
 * T5 — Tests sintéticos del matching del backfill M11
 * (CENTR-M11-BACKFILL-DESIGN.md §9). Code-level, sin BD (patrón del
 * proyecto). Cubren las 4 propiedades exigidas + el contrato de fuente
 * que garantiza el "no-merge" (findLeadsByPhone filtra a leads).
 */

const ROOT = path.resolve(__dirname, "..");

describe("backfill M11 — decisión de matching (pura)", () => {
  it("(a) idempotencia: contacto ya existe por shopify_customer_id → update, nunca create", () => {
    const d = decideBackfillContactAction({
      existsByCustomerId: true,
      effectivePhone: "+525512345678",
      effectiveEmail: "x@y.com",
      leadIdsByPhone: ["lead-1"],
      leadIdsByEmail: ["lead-2"],
    });
    expect(d.kind).toBe("update"); // re-run no duplica ni fusiona
  });

  it("(b) teléfono compartido entre dos customers de Shopify → cada uno CREATE, sin merge", () => {
    // Ningún lead comparte el teléfono (los clientes ya importados NO son
    // leads → findLeadsByPhone los excluye, así que llegan como []).
    const shared = "+525599887766";
    const custA = decideBackfillContactAction({
      existsByCustomerId: false, effectivePhone: shared, effectiveEmail: null,
      leadIdsByPhone: [], leadIdsByEmail: [],
    });
    const custB = decideBackfillContactAction({
      existsByCustomerId: false, effectivePhone: shared, effectiveEmail: null,
      leadIdsByPhone: [], leadIdsByEmail: [],
    });
    expect(custA.kind).toBe("create");
    expect(custB.kind).toBe("create"); // B NO se fusiona en A
  });

  it("(c) placeholder (compartido por ≥3) → phoneless → CREATE sin enlazar por teléfono", () => {
    const placeholder = "+525512345678";
    const placeholders = computePlaceholderPhones(
      new Map([[placeholder, 12], ["+525511112222", 2]]),
      3,
    );
    expect(placeholders.has(placeholder)).toBe(true);
    expect(placeholders.has("+525511112222")).toBe(false); // ×2 no es placeholder

    const { effectivePhone, isPlaceholder } = resolveEffectivePhone(placeholder, placeholders);
    expect(isPlaceholder).toBe(true);
    expect(effectivePhone).toBeNull(); // no actúa como clave de match

    const d = decideBackfillContactAction({
      existsByCustomerId: false, effectivePhone, effectiveEmail: null,
      // aunque hubiera leads con ese teléfono, effectivePhone=null los ignora
      leadIdsByPhone: ["lead-x"], leadIdsByEmail: [],
    });
    expect(d.kind).toBe("create"); // phoneless, sin merge con el placeholder
  });

  it("(d) customer entrante con teléfono de un lead pre-existente → LINK (lead se vuelve cliente)", () => {
    const d = decideBackfillContactAction({
      existsByCustomerId: false, effectivePhone: "+525544332211", effectiveEmail: null,
      leadIdsByPhone: ["lead-77"], leadIdsByEmail: [],
    });
    expect(d).toEqual({ kind: "link", leadId: "lead-77", matchBy: "phone" });
  });

  it("teléfono matchea >1 lead → conflict (no adivina), sin caer a email", () => {
    const d = decideBackfillContactAction({
      existsByCustomerId: false, effectivePhone: "+525500000000", effectiveEmail: "z@z.com",
      leadIdsByPhone: ["lead-a", "lead-b"], leadIdsByEmail: ["lead-c"],
    });
    expect(d).toEqual({ kind: "conflict", matchBy: "phone" });
  });

  it("sin teléfono pero email de un lead único → LINK por email", () => {
    const d = decideBackfillContactAction({
      existsByCustomerId: false, effectivePhone: null, effectiveEmail: "solo@mail.com",
      leadIdsByPhone: [], leadIdsByEmail: ["lead-e"],
    });
    expect(d).toEqual({ kind: "link", leadId: "lead-e", matchBy: "email" });
  });

  it("sin identificador fuerte → CREATE (isla, correcto)", () => {
    const d = decideBackfillContactAction({
      existsByCustomerId: false, effectivePhone: null, effectiveEmail: null,
      leadIdsByPhone: [], leadIdsByEmail: [],
    });
    expect(d.kind).toBe("create");
  });
});

describe("backfill M11 — contratos de fuente (guard estático)", () => {
  const contactsDb = readFileSync(path.resolve(ROOT, "lib", "db", "contacts.ts"), "utf8");
  const script = readFileSync(
    path.resolve(ROOT, "scripts", "shopify", "backfill-shopify-full.ts"),
    "utf8",
  );

  it("findLeadsByPhone/Email filtran a LEADS (shopify_customer_id IS NULL) — garantiza no-merge", () => {
    // Ambas funciones deben restringir a shopify_customer_id null; si alguien
    // lo quita, el tier-phone volvería a matchear clientes → merge-collapse.
    const phoneFn = contactsDb.slice(contactsDb.indexOf("findLeadsByPhone"));
    expect(phoneFn).toMatch(/\.is\("shopify_customer_id",\s*null\)/);
    const emailFn = contactsDb.slice(contactsDb.indexOf("findLeadsByEmail"));
    expect(emailFn).toMatch(/\.is\("shopify_customer_id",\s*null\)/);
  });

  it("el backfill usa el matcher lead-only, NO matchContactIdentity (que sí fusiona)", () => {
    expect(script).toContain("findLeadsByPhone");
    expect(script).toContain("decideBackfillContactAction");
    expect(script).not.toContain("matchContactIdentity");
  });

  it("el backfill setea backfill_in_progress en commit (suprime outbound/R12/motor)", () => {
    expect(script).toContain("backfill_in_progress: true");
    expect(script).toContain("backfill_in_progress: false");
  });
});
