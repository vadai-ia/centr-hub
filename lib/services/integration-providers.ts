import type { IntegrationProvider, IntegrationStatus } from "@/lib/types/database";

/**
 * Registro ÚNICO de los tres proveedores externos administrables (0046) y la
 * derivación PURA de su estado de salud.
 *
 * Módulo puro a propósito: no toca BD, Vault ni red. Lo consumen tanto las
 * server actions como el Client Component de la pantalla, y los tests lo
 * ejercitan sin mocks. Todo lo que sabe de secretos vive en `lib/vault`.
 *
 * Los DOS Whaapy son proveedores SEPARADOS (no un proveedor con dos
 * instancias): credenciales, businessId, endpoint y namespace de Vault
 * propios. Cualquier cosa que los trate como uno solo rompe el aislamiento
 * que la doctrina exige entre Venta y Post-venta.
 */

/** Credencial que el admin captura. Siempre write-only: nunca vuelve al cliente. */
export interface CredentialFieldDef {
  /** Key dentro del bag de Vault del proveedor (y de `credential_last4`). */
  key: string;
  label: string;
  /** Requerida para considerar la conexión completa. */
  required: boolean;
  /** Ayuda visible bajo el campo (español). */
  hint: string;
}

export interface IntegrationProviderDef {
  provider: IntegrationProvider;
  label: string;
  description: string;
  /** Namespace dentro de `organizations.vault_keys`. */
  vaultNamespace: "shopify" | "whaapy" | "whaapy_postventa";
  /** Columna de `organizations` que discrimina el tenant en los webhooks. */
  discriminatorColumn:
    | "shopify_store_domain"
    | "whaapy_business_id"
    | "whaapy_postventa_business_id";
  discriminatorLabel: string;
  discriminatorHint: string;
  discriminatorPlaceholder: string;
  /**
   * ¿La conexión NECESITA el discriminador para funcionar? No siempre: el
   * inbound del Whaapy de Post-venta resuelve el tenant por el slug que la
   * Automation manda en el body, no por businessId. Marcar como requerido
   * algo que el sistema no usa haría que la pantalla reporte "incompleta" una
   * integración que funciona — y una alarma falsa entrena a ignorar la alarma.
   */
  discriminatorRequired: boolean;
  /** Ruta del endpoint que el proveedor debe llamar. */
  callbackPath: string;
  credentials: readonly CredentialFieldDef[];
}

export const INTEGRATION_PROVIDERS: readonly IntegrationProviderDef[] = [
  {
    provider: "shopify",
    label: "Shopify",
    description:
      "Tienda de Shopify: pedidos, cotizaciones (draft orders), clientes y tags de vendedor.",
    vaultNamespace: "shopify",
    discriminatorColumn: "shopify_store_domain",
    discriminatorLabel: "Dominio de la tienda",
    discriminatorHint:
      "El dominio *.myshopify.com de la tienda. Resuelve la organización en cada webhook entrante y arma las llamadas a la Admin API.",
    discriminatorPlaceholder: "mi-tienda.myshopify.com",
    discriminatorRequired: true,
    callbackPath: "/api/webhooks/shopify",
    credentials: [
      {
        key: "client_id",
        label: "Client ID",
        required: true,
        hint: "Client ID de la app en el Shopify Dev Dashboard.",
      },
      {
        key: "client_secret",
        label: "Client Secret",
        required: true,
        hint: "Client Secret de la app. Shopify firma los webhooks con este mismo valor.",
      },
    ],
  },
  {
    provider: "whaapy_venta",
    label: "Whaapy Venta",
    description:
      "Instancia de Whaapy del equipo de venta: contactos, conversaciones y asignación de asesores.",
    vaultNamespace: "whaapy",
    discriminatorColumn: "whaapy_business_id",
    discriminatorLabel: "Business ID",
    discriminatorHint:
      "El businessId que Whaapy envía en la raíz de cada webhook. Resuelve la organización.",
    discriminatorPlaceholder: "1db0bff4-…",
    discriminatorRequired: true,
    callbackPath: "/api/webhooks/whaapy",
    credentials: [
      {
        key: "api_key",
        label: "API key",
        required: true,
        hint: "API key de Whaapy con scopes contacts:*, conversations:read/write, team:*, funnels:*.",
      },
      {
        key: "webhook_secret",
        label: "Secret del webhook",
        required: true,
        hint: "Whaapy lo muestra UNA vez al crear el webhook. Recrear el webhook genera uno nuevo: hay que pegarlo aquí o los eventos se descartan por firma inválida.",
      },
    ],
  },
  {
    provider: "whaapy_postventa",
    label: "Whaapy Post-venta",
    description:
      "Instancia de Whaapy de post-venta. Independiente de la de Venta: credenciales, businessId y endpoint propios.",
    vaultNamespace: "whaapy_postventa",
    discriminatorColumn: "whaapy_postventa_business_id",
    discriminatorLabel: "Business ID",
    discriminatorHint:
      "Opcional hoy: la resolución de casos entra por una Automation que manda el identificador de la organización en el cuerpo, así que este campo no se usa. Queda reservado por si se registra un webhook firmado en esta instancia. Si lo llenas, debe ser DISTINTO del de Venta.",
    discriminatorPlaceholder: "9ac1e0d2-…",
    discriminatorRequired: false,
    callbackPath: "/api/webhooks/whaapy-postventa",
    credentials: [
      {
        key: "api_key",
        label: "API key",
        required: true,
        hint: "API key de la instancia de Post-venta, con scopes funnels:read/write y contacts:read/write.",
      },
      {
        key: "webhook_secret",
        label: "Secret del webhook",
        required: false,
        hint: "Solo si se registra un webhook firmado en esta instancia. La resolución de casos entra por token, no por firma.",
      },
      {
        key: "inbound_token",
        label: "Token de la automatización",
        required: true,
        hint: "Token compartido que la Automation http_request de Whaapy manda al resolver un caso. Debe ser idéntico aquí y allá.",
      },
    ],
  },
] as const;

export function getProviderDef(provider: IntegrationProvider): IntegrationProviderDef {
  const def = INTEGRATION_PROVIDERS.find((p) => p.provider === provider);
  if (!def) throw new Error(`unknown_integration_provider: ${provider}`);
  return def;
}

/** Últimos 4 chars de una credencial — lo único de ella que llega a la UI. */
export function credentialLast4(raw: string): string {
  return raw.trim().slice(-4);
}

// ============================================================
// Derivación de salud (pura)
// ============================================================

export type IntegrationHealth =
  | "connected"
  | "incomplete"
  | "disconnected"
  | "not_configured";

export interface HealthInput {
  provider: IntegrationProvider;
  /** Intención guardada por el admin (`integration_connections.status`). */
  status: IntegrationStatus;
  /** Valor actual de la columna discriminadora en `organizations`. */
  discriminator: string | null;
  /** Keys de credenciales PRESENTES en Vault (nunca los valores). */
  presentCredentials: readonly string[];
}

export interface HealthResult {
  health: IntegrationHealth;
  /** Qué falta: keys de credenciales y/o "discriminator". */
  missing: string[];
  /** Frase corta en español para la tarjeta. */
  summary: string;
}

/**
 * Deriva la salud combinando intención + lo que realmente hay configurado.
 *
 * Regla de oro: la intención NO puede declarar "conectada" una conexión a la
 * que le falten piezas. Antes de esta pantalla, una organización con el bag de
 * Vault vacío "funcionaba" por fallback de env — y eso es justo lo que hace que
 * una segunda organización termine autenticando con las credenciales de la
 * primera. Con los getters fail-closed, "faltan credenciales" es un estado real
 * y visible, no una degradación silenciosa.
 */
export function deriveIntegrationHealth(input: HealthInput): HealthResult {
  const def = getProviderDef(input.provider);
  const required = def.credentials.filter((c) => c.required).map((c) => c.key);
  const present = new Set(input.presentCredentials);

  const missingCredentials = required.filter((k) => !present.has(k));
  const discriminatorAbsent = !input.discriminator?.trim();
  // Un discriminador ausente solo es una carencia si la conexión lo USA.
  const missingDiscriminator = def.discriminatorRequired && discriminatorAbsent;
  const missing = [
    ...(missingDiscriminator ? ["discriminator"] : []),
    ...missingCredentials,
  ];

  if (input.status === "disconnected") {
    return {
      health: "disconnected",
      missing,
      summary: "Desconectada. El histórico se conserva intacto.",
    };
  }

  const nothingConfigured =
    discriminatorAbsent && missingCredentials.length === required.length;
  if (nothingConfigured) {
    return {
      health: "not_configured",
      missing,
      summary: "Sin configurar.",
    };
  }

  if (missing.length > 0) {
    const parts: string[] = [];
    if (missingDiscriminator) parts.push(def.discriminatorLabel.toLowerCase());
    for (const key of missingCredentials) {
      const cred = def.credentials.find((c) => c.key === key);
      if (cred) parts.push(cred.label.toLowerCase());
    }
    return {
      health: "incomplete",
      missing,
      summary: `Incompleta: falta ${parts.join(", ")}.`,
    };
  }

  return {
    health: "connected",
    missing: [],
    summary: "Configurada.",
  };
}

/**
 * ¿Cambiar el discriminador exige el flujo de reemplazo (con desenlace)?
 * Sí en cuanto exista UNA sola fila enlazada: un id externo del sistema viejo
 * que sobreviva al cambio puede matchear contra una entidad distinta del
 * sistema nuevo. Sin filas enlazadas el cambio es inocuo (solo re-apunta).
 */
export function requiresReplacementFlow(linkedRowCount: number): boolean {
  return linkedRowCount > 0;
}

/** Suma de los conteos del dry-run (`count_integration_linked_rows`). */
export interface LinkedRowCounts {
  contacts: number;
  opportunities: number;
  orders: number;
  memberships: number;
  tag_mappings: number;
}

export const EMPTY_LINKED_COUNTS: LinkedRowCounts = {
  contacts: 0,
  opportunities: 0,
  orders: 0,
  memberships: 0,
  tag_mappings: 0,
};

export function totalLinkedRows(counts: LinkedRowCounts): number {
  // `tag_mappings` NO cuenta para el total: no lleva id externo, es un
  // catálogo de texto→asesor que sigue siendo válido (y editable) con la
  // tienda nueva. Se muestra como contexto, no como bloqueo.
  return counts.contacts + counts.opportunities + counts.orders + counts.memberships;
}

/** Palabra que el admin debe teclear para confirmar un reemplazo. */
export const REPLACE_CONFIRMATION_WORD = "reemplazar";
