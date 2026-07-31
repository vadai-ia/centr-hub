import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

/**
 * Fail-closed del Vault (0046).
 *
 * Antes, cada getter caía a una variable de entorno GLOBAL cuando el bag de la
 * organización estaba vacío. Con una sola organización eso pasaba por comodidad;
 * con dos es un fallo de aislamiento silencioso: la organización nueva escribe
 * en la tienda Shopify y en el Whaapy de la primera sin un solo error.
 *
 * Estos tests fijan el contrato: con env POBLADO y Vault VACÍO, cada getter
 * LANZA. Si alguien reintroduce el fallback "por conveniencia", esto falla.
 */

const fakeSupabase = new FakeSupabase();

// Env deliberadamente poblado: si el fallback volviera, estos valores harían
// pasar los tests en verde — por eso están aquí.
process.env.SHOPIFY_API_KEY = "env-client-id";
process.env.SHOPIFY_API_SECRET = "env-client-secret";
process.env.SHOPIFY_WEBHOOK_SECRET = "env-webhook-secret";
process.env.WHAAPY_API_KEY = "env-whaapy-key";
process.env.WHAAPY_POSTVENTA_API_KEY = "env-whaapy-postventa-key";

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => fakeSupabase,
}));

import {
  clearProviderCredentials,
  getShopifyClientId,
  getShopifyClientSecret,
  getShopifyWebhookSecret,
  getVaultCredentialPresence,
  getWhaapyApiKey,
  getWhaapyPostventaApiKey,
  getWhaapyPostventaInboundToken,
  getWhaapyWebhookSecret,
  storeProviderCredentials,
  VaultMissingCredentialError,
} from "@/lib/vault";

const ORG_A = "org-a";
const ORG_B = "org-b";

function seed(vaultKeys: Record<string, unknown>, orgId = ORG_A) {
  fakeSupabase.setTable("organizations", [{ id: orgId, vault_keys: vaultKeys }]);
}

beforeEach(() => {
  fakeSupabase.reset();
});

describe("getters fail-closed (env poblado, Vault vacío)", () => {
  const cases: Array<[string, (org: string) => Promise<string>]> = [
    ["shopify.client_id", getShopifyClientId],
    ["shopify.client_secret", getShopifyClientSecret],
    ["shopify.webhook_secret", getShopifyWebhookSecret],
    ["whaapy.api_key", getWhaapyApiKey],
    ["whaapy.webhook_secret", getWhaapyWebhookSecret],
    ["whaapy_postventa.api_key", getWhaapyPostventaApiKey],
    ["whaapy_postventa.inbound_token", getWhaapyPostventaInboundToken],
  ];

  for (const [name, getter] of cases) {
    it(`${name} lanza en vez de caer a la variable de entorno`, async () => {
      seed({});
      await expect(getter(ORG_A)).rejects.toBeInstanceOf(VaultMissingCredentialError);
    });
  }

  it("el error nombra la credencial y la organización, sin filtrar ningún valor", async () => {
    seed({});
    const err = await getShopifyClientSecret(ORG_A).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("client_secret");
    expect(message).toContain(ORG_A);
    expect(message).not.toContain("env-client-secret");
  });
});

describe("aislamiento entre organizaciones", () => {
  it("una organización SIN credenciales no hereda las de otra que sí las tiene", async () => {
    fakeSupabase.setTable("organizations", [
      { id: ORG_A, vault_keys: { shopify: { client_id: "A-id", client_secret: "A-secret" } } },
      { id: ORG_B, vault_keys: {} },
    ]);
    await expect(getShopifyClientId(ORG_A)).resolves.toBe("A-id");
    await expect(getShopifyClientId(ORG_B)).rejects.toBeInstanceOf(
      VaultMissingCredentialError,
    );
  });
});

describe("lectura de credenciales presentes", () => {
  it("devuelve solo las KEYS, nunca los valores", async () => {
    // Valores distintivos: si alguno se colara en la respuesta, el assert lo ve
    // (las KEYS sí contienen la palabra "secret", así que el canario no puede
    // ser esa palabra).
    seed({
      shopify: {
        client_id: "VALOR-CANARIO-CLIENT-ID",
        client_secret: "VALOR-CANARIO-CLIENT-SECRET",
        access_token: "VALOR-CANARIO-TOKEN",
      },
      whaapy: { api_key: "VALOR-CANARIO-WHAAPY" },
    });
    const presence = await getVaultCredentialPresence(ORG_A);
    expect(presence.shopify.sort()).toEqual(["client_id", "client_secret"]);
    expect(presence.whaapy_venta).toEqual(["api_key"]);
    expect(presence.whaapy_postventa).toEqual([]);
    expect(JSON.stringify(presence)).not.toContain("VALOR-CANARIO");
  });

  it("el access_token cacheado no cuenta como credencial configurada", async () => {
    seed({ shopify: { access_token: "tok", access_token_expires_at: "2030-01-01" } });
    const presence = await getVaultCredentialPresence(ORG_A);
    expect(presence.shopify).toEqual([]);
  });

  it("una credencial vacía cuenta como ausente", async () => {
    seed({ whaapy: { api_key: "" } });
    const presence = await getVaultCredentialPresence(ORG_A);
    expect(presence.whaapy_venta).toEqual([]);
  });
});

describe("escritura y borrado", () => {
  it("escribir hace merge: omitir una key conserva su valor (rotar solo el secret)", async () => {
    seed({ shopify: { client_id: "viejo-id", client_secret: "viejo-secret" } });
    await storeProviderCredentials(ORG_A, "shopify", { client_secret: "nuevo-secret" });
    await expect(getShopifyClientId(ORG_A)).resolves.toBe("viejo-id");
    await expect(getShopifyClientSecret(ORG_A)).resolves.toBe("nuevo-secret");
  });

  it("cambiar el client_secret invalida el access_token cacheado (era del secret viejo)", async () => {
    seed({
      shopify: {
        client_id: "id",
        client_secret: "viejo",
        access_token: "tok",
        access_token_expires_at: "2099-01-01T00:00:00.000Z",
      },
    });
    await storeProviderCredentials(ORG_A, "shopify", { client_secret: "nuevo" });
    const org = fakeSupabase.getTable("organizations")[0] as {
      vault_keys: { shopify: Record<string, unknown> };
    };
    expect(org.vault_keys.shopify.access_token).toBeUndefined();
    expect(org.vault_keys.shopify.client_id).toBe("id");
  });

  it("desconectar borra el bag del proveedor y NO toca los otros", async () => {
    seed({
      shopify: { client_id: "id", client_secret: "secret" },
      whaapy: { api_key: "k" },
      whaapy_postventa: { api_key: "kp" },
    });
    await clearProviderCredentials(ORG_A, "whaapy_venta");
    const presence = await getVaultCredentialPresence(ORG_A);
    expect(presence.whaapy_venta).toEqual([]);
    expect(presence.shopify.sort()).toEqual(["client_id", "client_secret"]);
    expect(presence.whaapy_postventa).toEqual(["api_key"]);
  });
});
