import { describe, expect, it } from "vitest";
import {
  generateWebhookSlug,
  generateWebhookToken,
  hashWebhookToken,
  tokenLast4,
  verifyWebhookToken,
} from "@/lib/services/webhook-token";
import { parseLeadWebhookPayload } from "@/lib/services/lead-payload";
import { selectRoundRobin } from "@/lib/services/lead-advisor-assignment";

/**
 * Piezas puras del webhook de leads (0038): token (hash/verify), contrato del
 * payload (Zod) y selección round-robin.
 */

describe("webhook-token", () => {
  it("hashea de forma determinista y verifica en tiempo constante", () => {
    const token = generateWebhookToken();
    const hash = hashWebhookToken(token);
    expect(hash).toBe(hashWebhookToken(token)); // determinista
    expect(hash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
    expect(verifyWebhookToken(token, hash)).toBe(true);
    expect(verifyWebhookToken("otro-token", hash)).toBe(false);
    expect(verifyWebhookToken("", hash)).toBe(false);
  });

  it("genera token con prefijo y slug hex; last4 correcto", () => {
    const token = generateWebhookToken();
    expect(token.startsWith("lead_")).toBe(true);
    expect(tokenLast4(token)).toBe(token.slice(-4));
    expect(generateWebhookSlug()).toMatch(/^[0-9a-f]{24}$/);
    // Dos tokens no colisionan.
    expect(generateWebhookToken()).not.toBe(generateWebhookToken());
  });
});

describe("parseLeadWebhookPayload", () => {
  it("acepta el payload mínimo (name + phone)", () => {
    const p = parseLeadWebhookPayload({ name: "Juan Pérez", phone: "5512345678" });
    expect(p.fullName).toBe("Juan Pérez");
    expect(p.phone).toBe("5512345678");
    expect(p.email).toBeNull();
    expect(p.address).toBeNull();
    expect(p.externalId).toBeNull();
  });

  it("normaliza email y mapea address string → { address1 }", () => {
    const p = parseLeadWebhookPayload({
      name: "María",
      phone: "+52 55 1234 5678",
      email: "MARIA@EJEMPLO.COM",
      address: "Av. Reforma 123, CDMX",
      external_id: "form-1",
    });
    expect(p.email).toBe("maria@ejemplo.com");
    expect(p.address).toEqual({ address1: "Av. Reforma 123, CDMX" });
    expect(p.externalId).toBe("form-1");
  });

  it("acepta address como objeto y limpia campos vacíos", () => {
    const p = parseLeadWebhookPayload({
      name: "A",
      phone: "1",
      address: { address1: "Calle 1", city: "CDMX", zip: "" },
    });
    expect(p.address).toEqual({ address1: "Calle 1", city: "CDMX" });
  });

  it("rechaza si falta name o phone", () => {
    expect(() => parseLeadWebhookPayload({ phone: "1" })).toThrow();
    expect(() => parseLeadWebhookPayload({ name: "A" })).toThrow();
    expect(() => parseLeadWebhookPayload({ name: "", phone: "1" })).toThrow();
  });

  it("rechaza email con formato inválido", () => {
    expect(() => parseLeadWebhookPayload({ name: "A", phone: "1", email: "no-es-email" })).toThrow();
  });
});

describe("selectRoundRobin", () => {
  it("devuelve null con lista vacía", () => {
    expect(selectRoundRobin([], 1)).toBeNull();
  });

  it("rota en orden y hace wrap con el módulo (contador 1-based)", () => {
    const items = ["a", "b", "c"];
    expect(selectRoundRobin(items, 1)).toBe("a");
    expect(selectRoundRobin(items, 2)).toBe("b");
    expect(selectRoundRobin(items, 3)).toBe("c");
    expect(selectRoundRobin(items, 4)).toBe("a"); // wrap
    expect(selectRoundRobin(items, 7)).toBe("a");
  });
});
