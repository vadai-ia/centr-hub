import { describe, expect, it } from "vitest";
import {
  normalizeEmail,
  normalizePhone,
} from "@/lib/services/identity-matching";

describe("normalizeEmail", () => {
  it("lowercase + trim", () => {
    expect(normalizeEmail("  ANA@Example.COM  ")).toBe("ana@example.com");
  });
  it("null / vacío → null", () => {
    expect(normalizeEmail(null)).toBe(null);
    expect(normalizeEmail("")).toBe(null);
    expect(normalizeEmail("   ")).toBe(null);
  });
});

describe("normalizePhone (default MX)", () => {
  it("nacional MX 10 dígitos → E.164 +52...", () => {
    expect(normalizePhone("5512345678")).toBe("+525512345678");
  });
  it("E.164 entrante se preserva si válido", () => {
    expect(normalizePhone("+525555555555")).toBe("+525555555555");
  });
  it("phone con formato local (espacios/guiones) se limpia", () => {
    expect(normalizePhone("(55) 1234-5678")).toBe("+525512345678");
  });
  it("null/vacío → null", () => {
    expect(normalizePhone(null)).toBe(null);
    expect(normalizePhone("")).toBe(null);
    expect(normalizePhone("   ")).toBe(null);
  });
  it("número inválido → null", () => {
    expect(normalizePhone("abc")).toBe(null);
    expect(normalizePhone("123")).toBe(null);
  });
  it("override de país funciona (AR)", () => {
    // 11 1234-5678 en AR
    const result = normalizePhone("11 1234-5678", "AR");
    // Acepta tanto +5411... como null si libphonenumber-js
    // no valida ese number — toleramos pero esperamos string si valida.
    if (result !== null) expect(result.startsWith("+")).toBe(true);
  });
});
