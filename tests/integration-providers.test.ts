import { describe, expect, it } from "vitest";
import {
  credentialLast4,
  deriveIntegrationHealth,
  EMPTY_LINKED_COUNTS,
  getProviderDef,
  INTEGRATION_PROVIDERS,
  requiresReplacementFlow,
  totalLinkedRows,
} from "@/lib/services/integration-providers";
import { TAB_REGISTRY } from "@/lib/auth/capabilities";

/**
 * Registro de proveedores + derivación PURA de salud (0046).
 *
 * El valor de estos tests es que la pantalla NO puede mentir sobre el estado
 * de una conexión: antes del fail-closed, "sin credenciales" se veía igual que
 * "conectada" porque el env tapaba el hueco.
 */

describe("registro de proveedores", () => {
  it("cubre exactamente los tres sistemas externos, con Whaapy Venta y Post-venta separados", () => {
    expect(INTEGRATION_PROVIDERS.map((p) => p.provider)).toEqual([
      "shopify",
      "whaapy_venta",
      "whaapy_postventa",
    ]);
  });

  it("cada Whaapy usa un namespace de Vault y un discriminador PROPIOS (aislamiento)", () => {
    const venta = getProviderDef("whaapy_venta");
    const post = getProviderDef("whaapy_postventa");
    expect(venta.vaultNamespace).not.toBe(post.vaultNamespace);
    expect(venta.discriminatorColumn).not.toBe(post.discriminatorColumn);
    expect(venta.callbackPath).not.toBe(post.callbackPath);
  });

  it("la pestaña admin-integraciones existe en el TAB_REGISTRY", () => {
    const tab = TAB_REGISTRY.find((t) => t.key === "admin-integraciones");
    expect(tab).toBeDefined();
    expect(tab?.section).toBe("admin");
    expect(tab?.href).toBe("/admin/integraciones");
  });

  it("credentialLast4 devuelve solo los últimos 4 caracteres", () => {
    expect(credentialLast4("shpss_supersecreto_ab12")).toBe("ab12");
    expect(credentialLast4("  xy  ")).toBe("xy");
  });
});

describe("derivación de salud", () => {
  const base = {
    provider: "shopify" as const,
    status: "connected" as const,
    discriminator: "centr.myshopify.com",
    presentCredentials: ["client_id", "client_secret"],
  };

  it("todo presente → conectada", () => {
    expect(deriveIntegrationHealth(base).health).toBe("connected");
  });

  it("falta una credencial requerida → incompleta (no 'conectada')", () => {
    const res = deriveIntegrationHealth({ ...base, presentCredentials: ["client_id"] });
    expect(res.health).toBe("incomplete");
    expect(res.missing).toContain("client_secret");
    expect(res.summary).toContain("client secret");
  });

  it("falta el discriminador → incompleta aunque las credenciales estén", () => {
    const res = deriveIntegrationHealth({ ...base, discriminator: null });
    expect(res.health).toBe("incomplete");
    expect(res.missing).toContain("discriminator");
  });

  it("un discriminador de solo espacios cuenta como ausente", () => {
    expect(deriveIntegrationHealth({ ...base, discriminator: "   " }).health).toBe(
      "incomplete",
    );
  });

  it("nada configurado → sin configurar", () => {
    const res = deriveIntegrationHealth({
      ...base,
      status: "not_configured",
      discriminator: null,
      presentCredentials: [],
    });
    expect(res.health).toBe("not_configured");
  });

  it("la intención 'disconnected' gana sobre cualquier credencial presente", () => {
    expect(deriveIntegrationHealth({ ...base, status: "disconnected" }).health).toBe(
      "disconnected",
    );
  });

  it("una credencial OPCIONAL ausente no degrada la salud (webhook_secret de Post-venta)", () => {
    const res = deriveIntegrationHealth({
      provider: "whaapy_postventa",
      status: "connected",
      discriminator: "biz-post",
      presentCredentials: ["api_key", "inbound_token"],
    });
    expect(res.health).toBe("connected");
  });

  it("el inbound_token de Post-venta SÍ es requerido (sin él la resolución de casos no entra)", () => {
    const res = deriveIntegrationHealth({
      provider: "whaapy_postventa",
      status: "connected",
      discriminator: "biz-post",
      presentCredentials: ["api_key"],
    });
    expect(res.health).toBe("incomplete");
    expect(res.missing).toContain("inbound_token");
  });
});

describe("guardarraíl de reemplazo", () => {
  it("sin filas enlazadas, cambiar el identificador no exige reemplazo", () => {
    expect(requiresReplacementFlow(0)).toBe(false);
  });

  it("UNA sola fila enlazada ya exige el flujo de reemplazo", () => {
    // Un solo id externo sobreviviente basta para que un id idéntico del
    // sistema nuevo matchee contra la entidad equivocada.
    expect(requiresReplacementFlow(1)).toBe(true);
  });

  it("los tag_mappings NO cuentan para el total (son texto→asesor, no ids externos)", () => {
    const counts = { ...EMPTY_LINKED_COUNTS, tag_mappings: 40 };
    expect(totalLinkedRows(counts)).toBe(0);
    expect(requiresReplacementFlow(totalLinkedRows(counts))).toBe(false);
  });

  it("contactos, oportunidades, pedidos y asesores sí suman", () => {
    expect(
      totalLinkedRows({
        contacts: 3,
        opportunities: 5,
        orders: 7,
        memberships: 2,
        tag_mappings: 99,
      }),
    ).toBe(17);
  });
});
