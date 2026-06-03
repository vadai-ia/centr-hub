import { describe, expect, it } from "vitest";
import {
  isEchoByCustomFieldMarker,
  readEchoMarker,
  WHAAPY_OUTBOUND_MARKER_FIELD,
} from "@/lib/services/whaapy-echo-detection";

/**
 * Detección de eco por marker `custom_fields.last_platform_write_at`
 * (R11 opción A) — capa generalizada usada por:
 *   - whaapyContactUpdated (sobre el snapshot del GET reconcile).
 *   - whaapyContactCreated (sobre el payload `data.custom_fields` del
 *     primer webhook — sin GET extra).
 *
 * Resuelve el caso del bug del Lead nuevo duplicado: cuando Shopify
 * → Whaapy creación automática dispara, Whaapy emite contact.created
 * de vuelta como eco. Sin esta detección, R12 trataba ese eco como
 * lead orgánico y creaba "Lead nuevo" innecesario.
 */

describe("isEchoByCustomFieldMarker", () => {
  it("detecta eco cuando el marker está dentro de la ventana de 5 min", () => {
    const now = new Date("2026-06-02T12:00:00Z");
    const markerTs = new Date(now.getTime() - 30_000); // 30s atrás
    const customFields = {
      [WHAAPY_OUTBOUND_MARKER_FIELD]: markerTs.toISOString(),
    };
    expect(isEchoByCustomFieldMarker(customFields, now.toISOString())).toBe(true);
  });

  it("acepta marker en el borde de la ventana (5 min exactos)", () => {
    const now = new Date("2026-06-02T12:00:00Z");
    const markerTs = new Date(now.getTime() - 5 * 60 * 1000); // 5min atrás
    const customFields = {
      [WHAAPY_OUTBOUND_MARKER_FIELD]: markerTs.toISOString(),
    };
    expect(isEchoByCustomFieldMarker(customFields, now.toISOString())).toBe(true);
  });

  it("rechaza marker fuera de la ventana (más de 5 min)", () => {
    const now = new Date("2026-06-02T12:00:00Z");
    const markerTs = new Date(now.getTime() - 6 * 60 * 1000); // 6min atrás
    const customFields = {
      [WHAAPY_OUTBOUND_MARKER_FIELD]: markerTs.toISOString(),
    };
    expect(isEchoByCustomFieldMarker(customFields, now.toISOString())).toBe(false);
  });

  it("rechaza marker con timestamp futuro (clock skew defensivo)", () => {
    const now = new Date("2026-06-02T12:00:00Z");
    const markerTs = new Date(now.getTime() + 10_000); // 10s adelante
    const customFields = {
      [WHAAPY_OUTBOUND_MARKER_FIELD]: markerTs.toISOString(),
    };
    expect(isEchoByCustomFieldMarker(customFields, now.toISOString())).toBe(false);
  });

  it("no detecta eco cuando el campo no existe (lead orgánico)", () => {
    const now = new Date("2026-06-02T12:00:00Z");
    // Customer fields de un lead orgánico que llegó por WhatsApp — el
    // marker NO debe existir en el webhook organico.
    const customFields = { something_else: "x" };
    expect(isEchoByCustomFieldMarker(customFields, now.toISOString())).toBe(false);
  });

  it("no detecta eco cuando custom_fields es null o undefined", () => {
    const now = new Date("2026-06-02T12:00:00Z");
    expect(isEchoByCustomFieldMarker(null, now.toISOString())).toBe(false);
    expect(isEchoByCustomFieldMarker(undefined, now.toISOString())).toBe(false);
  });

  it("rechaza marker con valor no-string (defensivo contra payloads malformados)", () => {
    const now = new Date("2026-06-02T12:00:00Z");
    expect(
      isEchoByCustomFieldMarker(
        { [WHAAPY_OUTBOUND_MARKER_FIELD]: 12345 },
        now.toISOString(),
      ),
    ).toBe(false);
    expect(
      isEchoByCustomFieldMarker(
        { [WHAAPY_OUTBOUND_MARKER_FIELD]: null },
        now.toISOString(),
      ),
    ).toBe(false);
  });

  it("rechaza marker con timestamp inparseable", () => {
    const now = new Date("2026-06-02T12:00:00Z");
    expect(
      isEchoByCustomFieldMarker(
        { [WHAAPY_OUTBOUND_MARKER_FIELD]: "no-es-fecha" },
        now.toISOString(),
      ),
    ).toBe(false);
  });
});

describe("readEchoMarker", () => {
  it("devuelve el string raw cuando existe", () => {
    expect(readEchoMarker({ [WHAAPY_OUTBOUND_MARKER_FIELD]: "2026-06-02T12:00:00Z" })).toBe(
      "2026-06-02T12:00:00Z",
    );
  });

  it("devuelve null cuando no hay marker", () => {
    expect(readEchoMarker({ other: "x" })).toBeNull();
    expect(readEchoMarker(null)).toBeNull();
    expect(readEchoMarker(undefined)).toBeNull();
  });

  it("devuelve null cuando el marker no es string", () => {
    expect(readEchoMarker({ [WHAAPY_OUTBOUND_MARKER_FIELD]: 123 })).toBeNull();
  });
});
