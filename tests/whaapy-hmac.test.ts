import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { verifyWhaapyHmac } from "@/lib/whaapy/hmac";

const SECRET = "whaapy_test_secret_abc123";

function sign(body: string, encoding: "base64" | "hex" = "base64"): string {
  return createHmac("sha256", SECRET).update(body, "utf8").digest(encoding);
}

describe("verifyWhaapyHmac", () => {
  it("acepta firma base64 válida", () => {
    const body = JSON.stringify({ event: "contact.created", data: { id: "x", businessId: "b" } });
    const sig = sign(body);
    expect(verifyWhaapyHmac(body, sig, SECRET)).toBe(true);
  });

  it("acepta firma hex válida (fallback)", () => {
    const body = JSON.stringify({ x: 1 });
    const sig = sign(body, "hex");
    expect(verifyWhaapyHmac(body, sig, SECRET)).toBe(true);
  });

  it("tolera prefijo sha256= en el header", () => {
    const body = JSON.stringify({ x: 2 });
    const sig = `sha256=${sign(body)}`;
    expect(verifyWhaapyHmac(body, sig, SECRET)).toBe(true);
  });

  it("rechaza firma inválida", () => {
    const body = JSON.stringify({ x: 3 });
    expect(verifyWhaapyHmac(body, "fakefakefake", SECRET)).toBe(false);
  });

  it("rechaza header vacío", () => {
    expect(verifyWhaapyHmac("x", "", SECRET)).toBe(false);
    expect(verifyWhaapyHmac("x", null, SECRET)).toBe(false);
  });

  it("rechaza secret vacío", () => {
    const body = JSON.stringify({ x: 4 });
    const sig = sign(body);
    expect(verifyWhaapyHmac(body, sig, "")).toBe(false);
  });

  it("rechaza body modificado tras firmar (constant-time)", () => {
    const body = JSON.stringify({ x: 5 });
    const sig = sign(body);
    const tamperedBody = JSON.stringify({ x: 5, evil: true });
    expect(verifyWhaapyHmac(tamperedBody, sig, SECRET)).toBe(false);
  });
});
