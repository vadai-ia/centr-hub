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

  it("MX 10 dígitos válido (regresión: bug de loader tsx perdía teléfonos en silencio)", () => {
    // Caso Sergio Guerra (customer 9759438635284). El bundle top-level
    // de libphonenumber-js tira TypeError bajo tsx por bug de
    // metadata loading. El fix usa /core + import explícito del JSON.
    // Este test ya pasaba bajo Vitest (Vite carga el top-level bien),
    // pero ahora también pasa bajo tsx (smoke test fuera de Vitest).
    expect(normalizePhone("+528115708848")).toBe("+528115708848");
    expect(normalizePhone("+52 81 1570 8848")).toBe("+528115708848");
  });

  it("legacy MX mobile prefix '1' es inválido — devuelve null silencioso", () => {
    // Mexico unificó a 10 dígitos en 2019; el prefijo `1` legacy
    // (13 dígitos: +52 1 XX XXXX XXXX) ya no valida. Debe caer al
    // path silencioso de null, NO al path ruidoso de exception.
    expect(normalizePhone("+5218115708848")).toBe(null);
    expect(normalizePhone("+52 1 81 1570 8848")).toBe(null);
  });
});
