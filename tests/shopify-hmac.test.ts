import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { verifyShopifyHmac } from "@/lib/shopify/hmac";

/**
 * HMAC verification — patrón crítico M3 (Sección 3.2).
 * Body raw + HMAC-SHA256 + comparación constant-time.
 */

const SECRET = "shpss_test_secret_for_unit_tests";
const BODY_JSON = JSON.stringify({ id: 123, email: "a@b.com" });

function signBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

describe("verifyShopifyHmac", () => {
  it("acepta firma válida sobre body raw", () => {
    const hmac = signBody(BODY_JSON, SECRET);
    expect(verifyShopifyHmac(BODY_JSON, hmac, SECRET)).toBe(true);
  });

  it("acepta Buffer como input además de string", () => {
    const hmac = signBody(BODY_JSON, SECRET);
    expect(verifyShopifyHmac(Buffer.from(BODY_JSON, "utf8"), hmac, SECRET)).toBe(true);
  });

  it("rechaza firma con un byte cambiado", () => {
    const hmac = signBody(BODY_JSON, SECRET);
    const tampered = hmac.slice(0, -2) + (hmac.endsWith("A") ? "B" : "A") + "=";
    expect(verifyShopifyHmac(BODY_JSON, tampered.slice(0, hmac.length), SECRET)).toBe(false);
  });

  it("rechaza firma cuando body cambia un byte", () => {
    const hmac = signBody(BODY_JSON, SECRET);
    const tampered = BODY_JSON.replace("a@b.com", "x@b.com");
    expect(verifyShopifyHmac(tampered, hmac, SECRET)).toBe(false);
  });

  it("rechaza si header es null/undefined", () => {
    expect(verifyShopifyHmac(BODY_JSON, null, SECRET)).toBe(false);
    expect(verifyShopifyHmac(BODY_JSON, undefined, SECRET)).toBe(false);
  });

  it("rechaza si secret está vacío", () => {
    const hmac = signBody(BODY_JSON, SECRET);
    expect(verifyShopifyHmac(BODY_JSON, hmac, "")).toBe(false);
  });

  it("rechaza firma de longitud distinta sin lanzar (timingSafeEqual exige misma longitud)", () => {
    // Hmac más corto que el esperado.
    expect(verifyShopifyHmac(BODY_JSON, "short==", SECRET)).toBe(false);
  });

  it("no expone diferencia temporal cuando los bytes difieren en pos 0 vs pos N", () => {
    // Tiempo no se mide en JS de forma confiable; se valida el comportamiento booleano
    // y se confía en `timingSafeEqual` para la propiedad constant-time.
    const hmac = signBody(BODY_JSON, SECRET);
    const flipFirst = Buffer.from(hmac, "base64");
    flipFirst[0] = flipFirst[0] ^ 0xff;
    const flipLast = Buffer.from(hmac, "base64");
    flipLast[flipLast.length - 1] = flipLast[flipLast.length - 1] ^ 0xff;
    expect(verifyShopifyHmac(BODY_JSON, flipFirst.toString("base64"), SECRET)).toBe(false);
    expect(verifyShopifyHmac(BODY_JSON, flipLast.toString("base64"), SECRET)).toBe(false);
  });
});
