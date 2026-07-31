"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenantContext } from "@/lib/tenant/context";
import { resolveAdminContext } from "@/lib/auth/admin-guard";
import { getOrganizationById, updateOrganization } from "@/lib/db/organizations";
import {
  countIntegrationLinkedRows,
  ensureIntegrationConnection,
  getIntegrationConnection,
  listIntegrationConnections,
  replaceIntegrationConnection,
  updateIntegrationConnection,
} from "@/lib/db/integration-connections";
import { getIngressStats, INGRESS_ENDPOINT_BY_PROVIDER } from "@/lib/db/webhook-ingress";
import {
  clearProviderCredentials,
  getVaultCredentialPresence,
  storeProviderCredentials,
  type VaultProviderKey,
} from "@/lib/vault";
import { probeIntegration } from "@/lib/services/integration-probe";
import {
  credentialLast4,
  deriveIntegrationHealth,
  EMPTY_LINKED_COUNTS,
  getProviderDef,
  INTEGRATION_PROVIDERS,
  REPLACE_CONFIRMATION_WORD,
  requiresReplacementFlow,
  totalLinkedRows,
  type IntegrationHealth,
  type LinkedRowCounts,
} from "@/lib/services/integration-providers";
import { recordAuditEvent } from "@/lib/db/operational";
import type {
  IntegrationProvider,
  IntegrationStatus,
  Json,
  OrganizationRow,
  UUID,
} from "@/lib/types/database";

/**
 * Server actions de Admin → Integraciones (0046). SOLO roles con la pestaña
 * `admin-integraciones`.
 *
 * DOS INVARIANTES DE SEGURIDAD, ambos estructurales (no "cuidado al editar"):
 *
 *   1. Los campos de credencial son WRITE-ONLY. Ninguna action devuelve un
 *      secreto: la vista expone `last4` + "configurada sí/no". No existe un
 *      camino de lectura porque no hay getter que lo ofrezca — para mostrar un
 *      secreto habría que escribir código nuevo a propósito.
 *
 *   2. Los audit y los mensajes llevan `last4`, nunca el valor. `audit_log`
 *      es legible por admins de la organización: un secreto ahí es un secreto
 *      filtrado, igual que uno en un log.
 */

const PROVIDERS = INTEGRATION_PROVIDERS.map((p) => p.provider) as [
  IntegrationProvider,
  ...IntegrationProvider[],
];
const providerSchema = z.enum(PROVIDERS);

// ============================================================
// Vista
// ============================================================

export interface CredentialView {
  key: string;
  label: string;
  required: boolean;
  hint: string;
  configured: boolean;
  last4: string | null;
}

export interface IngressView {
  total: number;
  rejected: number;
  lastExitReason: string | null;
  lastReceivedAt: string | null;
  windowHours: number;
}

export interface IntegrationCardView {
  provider: IntegrationProvider;
  label: string;
  description: string;
  status: IntegrationStatus;
  health: IntegrationHealth;
  summary: string;
  missing: string[];
  discriminatorLabel: string;
  discriminatorHint: string;
  discriminatorPlaceholder: string;
  discriminatorValue: string | null;
  /** false = la conexión funciona sin él (no se marca como carencia). */
  discriminatorRequired: boolean;
  callbackUrl: string;
  credentials: CredentialView[];
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  generation: number;
  /** Filas locales enlazadas a ESTE sistema externo (dry-run del reemplazo). */
  linked: LinkedRowCounts;
  linkedTotal: number;
  /** Si es true, cambiar el discriminador exige el flujo de reemplazo. */
  requiresReplacement: boolean;
  ingress: IngressView | null;
}

export type IntegrationsLoadResult =
  | { ok: true; cards: IntegrationCardView[] }
  | { ok: false; message: string };

const INGRESS_WINDOW_HOURS = 24;

function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

function discriminatorOf(
  org: OrganizationRow,
  provider: IntegrationProvider,
): string | null {
  const col = getProviderDef(provider).discriminatorColumn;
  return (org[col] as string | null) ?? null;
}

/**
 * Patch tipado de la columna discriminadora. Se arma con un switch explícito
 * en vez de una key computada: `{ [col]: value }` colapsa a `string` y perdería
 * la validación de que la columna existe en `OrganizationRow`.
 */
function discriminatorPatch(
  provider: IntegrationProvider,
  value: string,
  storeUrl?: string | null,
): Partial<OrganizationRow> {
  switch (provider) {
    case "shopify":
      return {
        shopify_store_domain: value,
        ...(storeUrl ? { shopify_store_url: storeUrl } : {}),
      };
    case "whaapy_venta":
      return { whaapy_business_id: value };
    case "whaapy_postventa":
      return { whaapy_postventa_business_id: value };
  }
}

function last4Map(raw: Json): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

async function buildCard(input: {
  organizationId: UUID;
  org: OrganizationRow;
  provider: IntegrationProvider;
  presence: Record<VaultProviderKey, string[]>;
}): Promise<IntegrationCardView> {
  const def = getProviderDef(input.provider);
  const row = await ensureIntegrationConnection(input.provider);
  const present = input.presence[input.provider] ?? [];
  const discriminator = discriminatorOf(input.org, input.provider);

  const health = deriveIntegrationHealth({
    provider: input.provider,
    status: row.status,
    discriminator,
    presentCredentials: present,
  });

  const stored = last4Map(row.credential_last4);
  const credentials: CredentialView[] = def.credentials.map((c) => ({
    key: c.key,
    label: c.label,
    required: c.required,
    hint: c.hint,
    configured: present.includes(c.key),
    // El last4 se muestra solo si la credencial sigue presente en Vault: si se
    // borró, un last4 huérfano sugeriría que hay algo configurado.
    last4: present.includes(c.key) ? (stored[c.key] ?? null) : null,
  }));

  let linked: LinkedRowCounts = { ...EMPTY_LINKED_COUNTS };
  try {
    linked = await countIntegrationLinkedRows(input.organizationId, input.provider);
  } catch {
    // El dry-run es informativo: si falla, la tarjeta se muestra igual y el
    // flujo de reemplazo lo vuelve a pedir antes de tocar nada.
  }

  let ingress: IngressView | null = null;
  try {
    const since = new Date(Date.now() - INGRESS_WINDOW_HOURS * 3600_000).toISOString();
    const stats = await getIngressStats(
      INGRESS_ENDPOINT_BY_PROVIDER[input.provider],
      since,
    );
    ingress = {
      total: stats.total,
      rejected: stats.rejected,
      lastExitReason: stats.lastExitReason,
      lastReceivedAt: stats.lastReceivedAt,
      windowHours: INGRESS_WINDOW_HOURS,
    };
  } catch {
    ingress = null;
  }

  const total = totalLinkedRows(linked);
  return {
    provider: input.provider,
    label: def.label,
    description: def.description,
    status: row.status,
    health: health.health,
    summary: health.summary,
    missing: health.missing,
    discriminatorLabel: def.discriminatorLabel,
    discriminatorHint: def.discriminatorHint,
    discriminatorPlaceholder: def.discriminatorPlaceholder,
    discriminatorValue: discriminator,
    discriminatorRequired: def.discriminatorRequired,
    callbackUrl: `${siteUrl()}${def.callbackPath}`,
    credentials,
    lastTestAt: row.last_test_at,
    lastTestOk: row.last_test_ok,
    lastTestMessage: row.last_test_message,
    generation: row.generation,
    linked,
    linkedTotal: total,
    requiresReplacement: requiresReplacementFlow(total),
    ingress,
  };
}

export async function loadIntegrationsAction(): Promise<IntegrationsLoadResult> {
  const admin = await resolveAdminContext("admin-integraciones");
  if (!admin.ok) return admin;
  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const org = await getOrganizationById(admin.ctx.orgId);
      if (!org) return { ok: false as const, message: "Organización no encontrada." };
      await listIntegrationConnections(); // materializa el acceso tenant-scoped
      const presence = await getVaultCredentialPresence(admin.ctx.orgId);
      const cards: IntegrationCardView[] = [];
      for (const def of INTEGRATION_PROVIDERS) {
        cards.push(
          await buildCard({
            organizationId: admin.ctx.orgId,
            org,
            provider: def.provider,
            presence,
          }),
        );
      }
      return { ok: true as const, cards };
    },
    { source: "user_session" },
  );
}

// ============================================================
// Guardar credenciales (write-only)
// ============================================================

const saveCredentialsSchema = z.object({
  provider: providerSchema,
  // Solo llegan las credenciales que el admin escribió. Una key ausente
  // significa "no la toques" — así se rota el secret sin re-capturar el resto.
  values: z.record(z.string(), z.string().trim().min(1).max(500)),
});

export type IntegrationMutationResult =
  | { ok: true; cards: IntegrationCardView[]; message: string }
  | { ok: false; message: string };

/**
 * Igual que `IntegrationMutationResult`, pero el fallo puede indicar que el
 * cambio exige el flujo de reemplazo (hay datos enlazados).
 */
export type DiscriminatorSaveResult =
  | { ok: true; cards: IntegrationCardView[]; message: string }
  | { ok: false; message: string; requiresReplacement?: boolean };

async function reloadCards(orgId: UUID): Promise<IntegrationCardView[]> {
  const org = await getOrganizationById(orgId);
  if (!org) return [];
  const presence = await getVaultCredentialPresence(orgId);
  const cards: IntegrationCardView[] = [];
  for (const def of INTEGRATION_PROVIDERS) {
    cards.push(
      await buildCard({ organizationId: orgId, org, provider: def.provider, presence }),
    );
  }
  return cards;
}

export async function saveIntegrationCredentialsAction(
  raw: unknown,
): Promise<IntegrationMutationResult> {
  const parsed = saveCredentialsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Datos inválidos." };
  const admin = await resolveAdminContext("admin-integraciones");
  if (!admin.ok) return admin;

  const def = getProviderDef(parsed.data.provider);
  const allowed = new Set(def.credentials.map((c) => c.key));
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed.data.values)) {
    if (allowed.has(k)) values[k] = v;
  }
  if (Object.keys(values).length === 0) {
    return { ok: false, message: "No se recibió ninguna credencial válida." };
  }

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      await ensureIntegrationConnection(parsed.data.provider);
      await storeProviderCredentials(admin.ctx.orgId, parsed.data.provider, values);

      // last4 SOLO de lo que se acaba de escribir; el resto conserva el suyo.
      const row = await getIntegrationConnection(parsed.data.provider);
      const merged = { ...last4Map(row?.credential_last4 ?? {}) };
      for (const [k, v] of Object.entries(values)) merged[k] = credentialLast4(v);

      const presence = await getVaultCredentialPresence(admin.ctx.orgId);
      const org = await getOrganizationById(admin.ctx.orgId);
      const health = deriveIntegrationHealth({
        provider: parsed.data.provider,
        status: "connected",
        discriminator: org ? discriminatorOf(org, parsed.data.provider) : null,
        presentCredentials: presence[parsed.data.provider] ?? [],
      });

      await updateIntegrationConnection(parsed.data.provider, {
        credential_last4: merged as Json,
        // Guardar credenciales reactiva una conexión desconectada: el admin
        // acaba de declarar que quiere usarla.
        status: "connected",
        connected_at: new Date().toISOString(),
        disconnected_at: null,
        updated_by_user_id: admin.ctx.userId,
      });

      await recordAuditEvent({
        actorUserId: admin.ctx.userId,
        eventType: "integration_credentials_updated",
        entityType: "integration_connection",
        entityId: null,
        // Solo qué keys cambiaron y sus last4 — nunca el valor.
        payload: {
          provider: parsed.data.provider,
          keys: Object.keys(values),
          last4: Object.fromEntries(
            Object.entries(values).map(([k, v]) => [k, credentialLast4(v)]),
          ),
        } as Json,
      });

      revalidatePath("/admin/integraciones");
      return {
        ok: true as const,
        cards: await reloadCards(admin.ctx.orgId),
        message:
          health.health === "connected"
            ? "Credenciales guardadas. Prueba la conexión para verificarlas."
            : `Credenciales guardadas. ${health.summary}`,
      };
    },
    { source: "user_session" },
  );
}

// ============================================================
// Discriminador (con guardarraíl)
// ============================================================

const saveDiscriminatorSchema = z.object({
  provider: providerSchema,
  value: z.string().trim().min(1).max(200),
  storeUrl: z.string().trim().max(300).optional().nullable(),
});

function validateDiscriminator(
  provider: IntegrationProvider,
  value: string,
): string | null {
  if (provider === "shopify" && !value.toLowerCase().endsWith(".myshopify.com")) {
    return "El dominio debe terminar en .myshopify.com";
  }
  return null;
}

/**
 * Cambia el discriminador SOLO cuando no hay nada enlazado. Con filas
 * enlazadas devuelve `requires_replacement` y la UI manda al flujo de
 * reemplazo — cambiar el identificador dejando los ids del sistema viejo es
 * exactamente lo que fusiona entidades de dos sistemas distintos.
 */
export async function saveIntegrationDiscriminatorAction(
  raw: unknown,
): Promise<DiscriminatorSaveResult> {
  const parsed = saveDiscriminatorSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Datos inválidos." };
  const admin = await resolveAdminContext("admin-integraciones");
  if (!admin.ok) return admin;

  const formatError = validateDiscriminator(parsed.data.provider, parsed.data.value);
  if (formatError) return { ok: false, message: formatError };

  const def = getProviderDef(parsed.data.provider);

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const org = await getOrganizationById(admin.ctx.orgId);
      if (!org) return { ok: false as const, message: "Organización no encontrada." };
      const current = discriminatorOf(org, parsed.data.provider);
      if (current === parsed.data.value) {
        return {
          ok: true as const,
          cards: await reloadCards(admin.ctx.orgId),
          message: "Sin cambios.",
        };
      }

      if (current) {
        const linked = await countIntegrationLinkedRows(
          admin.ctx.orgId,
          parsed.data.provider,
        );
        if (requiresReplacementFlow(totalLinkedRows(linked))) {
          return {
            ok: false as const,
            requiresReplacement: true,
            message:
              "Ya hay datos enlazados a esta conexión. Usa “Reemplazar conexión” para cambiarla de forma segura.",
          };
        }
      }

      await ensureIntegrationConnection(parsed.data.provider);
      await updateOrganization(
        admin.ctx.orgId,
        discriminatorPatch(parsed.data.provider, parsed.data.value, parsed.data.storeUrl),
      );
      await updateIntegrationConnection(parsed.data.provider, {
        updated_by_user_id: admin.ctx.userId,
      });
      await recordAuditEvent({
        actorUserId: admin.ctx.userId,
        eventType: "integration_discriminator_updated",
        entityType: "integration_connection",
        entityId: null,
        payload: {
          provider: parsed.data.provider,
          column: def.discriminatorColumn,
          previous: current,
          next: parsed.data.value,
        } as Json,
      });
      revalidatePath("/admin/integraciones");
      return {
        ok: true as const,
        cards: await reloadCards(admin.ctx.orgId),
        message: `${def.discriminatorLabel} actualizado.`,
      };
    },
    { source: "user_session" },
  );
}

// ============================================================
// Probar conexión
// ============================================================

export async function testIntegrationAction(
  raw: unknown,
): Promise<IntegrationMutationResult> {
  const parsed = z.object({ provider: providerSchema }).safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Datos inválidos." };
  const admin = await resolveAdminContext("admin-integraciones");
  if (!admin.ok) return admin;

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const org = await getOrganizationById(admin.ctx.orgId);
      if (!org) return { ok: false as const, message: "Organización no encontrada." };
      await ensureIntegrationConnection(parsed.data.provider);

      const result = await probeIntegration({
        organizationId: admin.ctx.orgId,
        provider: parsed.data.provider,
        shopDomain: org.shopify_store_domain,
      });

      const message = [result.message, ...result.details].join(" · ");
      await updateIntegrationConnection(parsed.data.provider, {
        last_test_at: new Date().toISOString(),
        last_test_ok: result.ok,
        last_test_message: message.slice(0, 500),
        updated_by_user_id: admin.ctx.userId,
      });
      await recordAuditEvent({
        actorUserId: admin.ctx.userId,
        eventType: "integration_connection_tested",
        entityType: "integration_connection",
        entityId: null,
        payload: { provider: parsed.data.provider, ok: result.ok } as Json,
      });
      revalidatePath("/admin/integraciones");
      return {
        ok: result.ok,
        cards: await reloadCards(admin.ctx.orgId),
        message,
      } as IntegrationMutationResult;
    },
    { source: "user_session" },
  );
}

// ============================================================
// Desconectar / reconectar
// ============================================================

/**
 * Desconectar = DESACTIVAR. Borra las credenciales (dejan de servir y no
 * deben quedar accesibles) y marca la conexión como desconectada. NO toca
 * ningún id externo ni una sola fila de negocio: reconectar el MISMO sistema
 * restaura el enlace tal cual estaba. Nada se borra nunca por esta vía.
 */
export async function disconnectIntegrationAction(
  raw: unknown,
): Promise<IntegrationMutationResult> {
  const parsed = z.object({ provider: providerSchema }).safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Datos inválidos." };
  const admin = await resolveAdminContext("admin-integraciones");
  if (!admin.ok) return admin;

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      await ensureIntegrationConnection(parsed.data.provider);
      await clearProviderCredentials(admin.ctx.orgId, parsed.data.provider);
      await updateIntegrationConnection(parsed.data.provider, {
        status: "disconnected",
        credential_last4: {} as Json,
        disconnected_at: new Date().toISOString(),
        last_test_at: null,
        last_test_ok: null,
        last_test_message: null,
        updated_by_user_id: admin.ctx.userId,
      });
      await recordAuditEvent({
        actorUserId: admin.ctx.userId,
        eventType: "integration_connection_disconnected",
        entityType: "integration_connection",
        entityId: null,
        payload: { provider: parsed.data.provider } as Json,
      });
      revalidatePath("/admin/integraciones");
      return {
        ok: true as const,
        cards: await reloadCards(admin.ctx.orgId),
        message:
          "Conexión desconectada. El histórico y los enlaces se conservan: al volver a capturar credenciales del mismo sistema, todo sigue enlazado.",
      };
    },
    { source: "user_session" },
  );
}

// ============================================================
// Reemplazo (dry-run + ejecución)
// ============================================================

export interface ReplacePreview {
  provider: IntegrationProvider;
  currentDiscriminator: string | null;
  linked: LinkedRowCounts;
  linkedTotal: number;
  confirmationWord: string;
  /** Frases en español de lo que se va a desenlazar. */
  effects: string[];
}

export type ReplacePreviewResult =
  | { ok: true; preview: ReplacePreview }
  | { ok: false; message: string };

function describeEffects(
  provider: IntegrationProvider,
  linked: LinkedRowCounts,
): string[] {
  if (provider === "shopify") {
    return [
      `${linked.contacts} contacto(s) pierden su vínculo con el cliente de Shopify (y sus tags de Shopify).`,
      `${linked.opportunities} oportunidad(es) pierden su referencia a cotización/pedido de Shopify.`,
      `${linked.orders} pedido(s) quedan marcados como desenlazados (se conserva el número original).`,
      `${linked.tag_mappings} mapeo(s) de tags se conservan: son texto→asesor y siguen siendo válidos.`,
      "Las credenciales de la tienda actual se borran.",
    ];
  }
  if (provider === "whaapy_venta") {
    return [
      `${linked.contacts} contacto(s) pierden su vínculo con el contacto de Whaapy y su última actividad.`,
      `${linked.memberships} asesor(es) pierden su mapeo con el agente de Whaapy (hay que rehacerlo en Admin → Agentes Whaapy).`,
      "Las credenciales de la instancia actual se borran.",
    ];
  }
  return [
    "No hay identidades locales que desenlazar: esta instancia se matchea por teléfono.",
    "Las credenciales de la instancia actual se borran.",
    "Los contactos que ya viven en la instancia vieja conservan allá sus campos centrhub_*; la instancia nueva arranca limpia.",
  ];
}

export async function previewReplaceIntegrationAction(
  raw: unknown,
): Promise<ReplacePreviewResult> {
  const parsed = z.object({ provider: providerSchema }).safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Datos inválidos." };
  const admin = await resolveAdminContext("admin-integraciones");
  if (!admin.ok) return admin;

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const org = await getOrganizationById(admin.ctx.orgId);
      if (!org) return { ok: false as const, message: "Organización no encontrada." };
      const linked = await countIntegrationLinkedRows(
        admin.ctx.orgId,
        parsed.data.provider,
      );
      return {
        ok: true as const,
        preview: {
          provider: parsed.data.provider,
          currentDiscriminator: discriminatorOf(org, parsed.data.provider),
          linked,
          linkedTotal: totalLinkedRows(linked),
          confirmationWord: REPLACE_CONFIRMATION_WORD,
          effects: describeEffects(parsed.data.provider, linked),
        },
      };
    },
    { source: "user_session" },
  );
}

const replaceSchema = z.object({
  provider: providerSchema,
  newDiscriminator: z.string().trim().min(1).max(200),
  storeUrl: z.string().trim().max(300).optional().nullable(),
  confirmation: z.string(),
});

/**
 * Ejecuta el reemplazo. La confirmación tecleada se revalida AQUÍ (no solo en
 * el cliente) — mismo patrón que el borrado de una etapa ligada a
 * automatizaciones. El desenlace corre dentro del RPC atómico: o cambia todo,
 * o no cambia nada.
 */
export async function replaceIntegrationAction(
  raw: unknown,
): Promise<IntegrationMutationResult> {
  const parsed = replaceSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Datos inválidos." };
  const admin = await resolveAdminContext("admin-integraciones");
  if (!admin.ok) return admin;

  if (parsed.data.confirmation.trim().toLowerCase() !== REPLACE_CONFIRMATION_WORD) {
    return {
      ok: false,
      message: `Escribe “${REPLACE_CONFIRMATION_WORD}” para confirmar el reemplazo.`,
    };
  }
  const formatError = validateDiscriminator(
    parsed.data.provider,
    parsed.data.newDiscriminator,
  );
  if (formatError) return { ok: false, message: formatError };

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const org = await getOrganizationById(admin.ctx.orgId);
      if (!org) return { ok: false as const, message: "Organización no encontrada." };
      const current = discriminatorOf(org, parsed.data.provider);
      if (current === parsed.data.newDiscriminator) {
        return {
          ok: false as const,
          message: "El identificador nuevo es igual al actual. No hay nada que reemplazar.",
        };
      }
      await ensureIntegrationConnection(parsed.data.provider);

      let result;
      try {
        result = await replaceIntegrationConnection({
          organizationId: admin.ctx.orgId,
          provider: parsed.data.provider,
          newDiscriminator: parsed.data.newDiscriminator,
          actorUserId: admin.ctx.userId,
          newStoreUrl: parsed.data.storeUrl ?? null,
        });
      } catch (err) {
        const msg = (err as { message?: string })?.message ?? "";
        // UNIQUE de la columna discriminadora: ese identificador ya pertenece
        // a otra organización de la instalación.
        if (msg.includes("unique") || msg.includes("duplicate")) {
          return {
            ok: false as const,
            message: "Ese identificador ya está en uso por otra organización.",
          };
        }
        return {
          ok: false as const,
          message: "No se pudo completar el reemplazo. No se cambió nada.",
        };
      }

      revalidatePath("/admin/integraciones");
      const u = result.unlinked;
      return {
        ok: true as const,
        cards: await reloadCards(admin.ctx.orgId),
        message:
          `Conexión reemplazada (generación ${result.generation}). Desenlazados: ` +
          `${u.contacts} contacto(s), ${u.opportunities} oportunidad(es), ${u.orders} pedido(s), ` +
          `${u.memberships} asesor(es). Captura las credenciales del sistema nuevo para reactivarla.`,
      };
    },
    { source: "user_session" },
  );
}
