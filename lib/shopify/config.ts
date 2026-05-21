import "server-only";

/**
 * Configuración compartida del cliente Shopify.
 *
 * El API version se centraliza acá para que mappers, cliente REST,
 * cliente GraphQL y el script de webhook subscriptions usen la misma.
 * Migrar de versión = cambiar SOLO esta constante + ejecutar tests
 * sintéticos + verificar que ningún campo desaparezca de los mappers.
 *
 * R-PARSER (frágilidad de GraphQL `tag:`): documentar sintaxis
 * validada en CLAUDE.md cuando se introduzca la primera query.
 */

export const SHOPIFY_API_VERSION = "2026-01" as const;

/** Marker que viaja en propiedades custom de outbound writes (R11 opción A). */
export const SHOPIFY_OUTBOUND_ORIGIN_MARKER = "centrhub" as const;

export function buildShopifyAdminBaseUrl(shopDomain: string): string {
  if (!shopDomain || !shopDomain.endsWith(".myshopify.com")) {
    throw new Error(
      `shopify: shopDomain inválido (esperaba *.myshopify.com): ${shopDomain}`,
    );
  }
  return `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}`;
}

export function buildShopifyOAuthTokenUrl(shopDomain: string): string {
  if (!shopDomain || !shopDomain.endsWith(".myshopify.com")) {
    throw new Error(
      `shopify: shopDomain inválido (esperaba *.myshopify.com): ${shopDomain}`,
    );
  }
  return `https://${shopDomain}/admin/oauth/access_token`;
}
