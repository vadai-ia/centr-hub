import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Guardas del reemplazo de conexión — enforcement en SERVIDOR.
 *
 * El modal deshabilita el botón hasta que el admin teclea la palabra y marca
 * el respaldo, pero un gate de UI no es una garantía: la action es alcanzable
 * directamente. Estos tests fijan que ninguna de las dos guardas depende del
 * cliente, y que el RPC destructivo NO se invoca si falta cualquiera.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/tenant/context", () => ({
  withTenantContext: (_org: string, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/capabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/capabilities")>();
  return { ...actual, hasTab: vi.fn(() => true) };
});
vi.mock("@/lib/db/organizations", () => ({
  getOrganizationById: vi.fn(),
  updateOrganization: vi.fn(),
}));
vi.mock("@/lib/db/integration-connections", () => ({
  countIntegrationLinkedRows: vi.fn(),
  ensureIntegrationConnection: vi.fn(),
  getIntegrationConnection: vi.fn(),
  listIntegrationConnections: vi.fn(),
  replaceIntegrationConnection: vi.fn(),
  updateIntegrationConnection: vi.fn(),
}));
vi.mock("@/lib/db/webhook-ingress", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/webhook-ingress")>();
  return { ...actual, getIngressStats: vi.fn(async () => null) };
});
vi.mock("@/lib/vault", () => ({
  clearProviderCredentials: vi.fn(),
  getVaultCredentialPresence: vi.fn(async () => ({
    shopify: ["client_id", "client_secret"],
    whaapy_venta: [],
    whaapy_postventa: [],
  })),
  storeProviderCredentials: vi.fn(),
}));
vi.mock("@/lib/services/integration-probe", () => ({ probeIntegration: vi.fn() }));
vi.mock("@/lib/db/operational", () => ({ recordAuditEvent: vi.fn() }));

import { replaceIntegrationAction } from "@/lib/actions/admin-integrations";
import { getSession } from "@/lib/auth/session";
import { getOrganizationById } from "@/lib/db/organizations";
import {
  countIntegrationLinkedRows,
  ensureIntegrationConnection,
  getIntegrationConnection,
  replaceIntegrationConnection,
  updateIntegrationConnection,
} from "@/lib/db/integration-connections";
import { recordAuditEvent } from "@/lib/db/operational";
import type { IntegrationConnectionRow } from "@/lib/types/database";

const ORG = "org-1";
const mSession = vi.mocked(getSession);
const mOrg = vi.mocked(getOrganizationById);
const mReplace = vi.mocked(replaceIntegrationConnection);
const mAudit = vi.mocked(recordAuditEvent);
const mEnsure = vi.mocked(ensureIntegrationConnection);
const mGetConn = vi.mocked(getIntegrationConnection);
const mUpdateConn = vi.mocked(updateIntegrationConnection);
const mCounts = vi.mocked(countIntegrationLinkedRows);

function connRow(): IntegrationConnectionRow {
  return {
    id: "conn-1",
    organization_id: ORG,
    provider: "shopify",
    status: "connected",
    credential_last4: {},
    callback_url: null,
    webhook_registered_at: null,
    last_test_at: null,
    last_test_ok: null,
    last_test_message: null,
    connected_at: null,
    disconnected_at: null,
    generation: 1,
    updated_by_user_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    provider: "shopify",
    newDiscriminator: "tienda-nueva.myshopify.com",
    storeUrl: null,
    confirmation: "reemplazar",
    backupAcknowledged: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mSession.mockResolvedValue({
    status: "ok",
    data: {
      userId: "user-admin",
      activeOrg: { id: ORG },
      activeRole: {
        key: "admin",
        label: "Administrador",
        allowedTabs: ["admin-integraciones"],
        dataScope: "all",
        isSystem: true,
      },
    },
  } as unknown as Awaited<ReturnType<typeof getSession>>);
  mOrg.mockResolvedValue({
    id: ORG,
    shopify_store_domain: "tienda-vieja.myshopify.com",
    whaapy_business_id: "biz-venta",
    whaapy_postventa_business_id: null,
  } as unknown as Awaited<ReturnType<typeof getOrganizationById>>);
  mReplace.mockResolvedValue({
    provider: "shopify",
    generation: 2,
    unlinked: { contacts: 1, opportunities: 1, orders: 1, memberships: 0, tag_mappings: 0 },
  });
  mEnsure.mockResolvedValue(connRow());
  mGetConn.mockResolvedValue(connRow());
  mUpdateConn.mockResolvedValue(connRow());
  mCounts.mockResolvedValue({
    contacts: 1,
    opportunities: 1,
    orders: 1,
    memberships: 0,
    tag_mappings: 0,
  });
});

describe("guardas del reemplazo (enforcement en servidor)", () => {
  it("sin reconocer el respaldo NO se ejecuta el reemplazo, aunque la palabra sea correcta", async () => {
    const res = await replaceIntegrationAction(baseInput({ backupAcknowledged: false }));
    expect(res.ok).toBe(false);
    expect(res.message).toContain("respaldo");
    expect(mReplace).not.toHaveBeenCalled();
  });

  it("sin la palabra tecleada NO se ejecuta, aunque el respaldo esté reconocido", async () => {
    const res = await replaceIntegrationAction(baseInput({ confirmation: "sí" }));
    expect(res.ok).toBe(false);
    expect(mReplace).not.toHaveBeenCalled();
  });

  it("omitir el campo del respaldo se rechaza (no se asume 'true' por ausencia)", async () => {
    const input = baseInput();
    delete (input as Record<string, unknown>).backupAcknowledged;
    const res = await replaceIntegrationAction(input);
    expect(res.ok).toBe(false);
    expect(mReplace).not.toHaveBeenCalled();
  });

  it("con ambas guardas satisfechas sí ejecuta el RPC atómico", async () => {
    const res = await replaceIntegrationAction(baseInput());
    expect(res.ok).toBe(true);
    expect(mReplace).toHaveBeenCalledTimes(1);
    expect(mReplace.mock.calls[0][0]).toMatchObject({
      organizationId: ORG,
      provider: "shopify",
      newDiscriminator: "tienda-nueva.myshopify.com",
    });
  });

  it("deja rastro de quién declaró tener respaldo ANTES de tocar nada", async () => {
    await replaceIntegrationAction(baseInput());
    const events = mAudit.mock.calls.map((c) => c[0].eventType);
    expect(events).toContain("integration_replace_backup_acknowledged");
    // El audit precede a la llamada destructiva: si el RPC revienta y hace
    // rollback, el intento igual queda registrado.
    const auditOrder = mAudit.mock.invocationCallOrder[0];
    const replaceOrder = mReplace.mock.invocationCallOrder[0];
    expect(auditOrder).toBeLessThan(replaceOrder);
  });

  it("la palabra de confirmación tolera mayúsculas y espacios, pero no otra palabra", async () => {
    expect((await replaceIntegrationAction(baseInput({ confirmation: "  REEMPLAZAR " }))).ok).toBe(
      true,
    );
    mReplace.mockClear();
    expect((await replaceIntegrationAction(baseInput({ confirmation: "reemplazame" }))).ok).toBe(
      false,
    );
    expect(mReplace).not.toHaveBeenCalled();
  });

  it("un dominio de Shopify sin .myshopify.com se rechaza antes del RPC", async () => {
    const res = await replaceIntegrationAction(
      baseInput({ newDiscriminator: "tienda-nueva.com" }),
    );
    expect(res.ok).toBe(false);
    expect(mReplace).not.toHaveBeenCalled();
  });
});
