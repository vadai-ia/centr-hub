import "server-only";
import { shopifyRest, ShopifyApiError } from "@/lib/shopify/admin-client";
import { listWhaapyTeam } from "@/lib/whaapy/team";
import { WhaapyApiError } from "@/lib/whaapy/admin-client";
import { whaapyPostventaRest } from "@/lib/whaapy-postventa/client";
import { WHAAPY_POSTVENTA_STAGE_NAMES } from "@/lib/whaapy-postventa/config";
import { VaultMissingCredentialError } from "@/lib/vault";
import type { IntegrationProvider, UUID } from "@/lib/types/database";

/**
 * "Probar conexión" — una llamada REAL y de solo lectura por proveedor.
 *
 * Cada probe usa el endpoint más barato que demuestra las tres cosas a la
 * vez: credencial válida, permiso suficiente y que apuntamos al sistema que
 * el admin cree. Devuelve un mensaje en español apto para mostrar.
 *
 * INVARIANTE DE SEGURIDAD: el mensaje NUNCA incluye la credencial ni el body
 * crudo del proveedor. Se propaga el código HTTP y, cuando existe, el detalle
 * de validación del proveedor — nada más. Lo mismo aplica a lo que se
 * persiste en `integration_connections.last_test_message` y a lo que se
 * loguea: un secreto en un log es un secreto filtrado.
 */

export interface ProbeResult {
  ok: boolean;
  /** Mensaje para la tarjeta (español, sin secretos). */
  message: string;
  /** Datos de identificación del sistema remoto, para que el admin confirme. */
  details: string[];
}

const MAX_MESSAGE = 300;

function truncate(s: string): string {
  return s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE)}…` : s;
}

/** Traduce un fallo a un mensaje accionable sin volcar nada sensible. */
function describeError(err: unknown): string {
  if (err instanceof VaultMissingCredentialError) {
    return "Faltan credenciales. Captúralas y vuelve a probar.";
  }
  if (err instanceof ShopifyApiError || err instanceof WhaapyApiError) {
    const status = err.status;
    if (status === 401 || status === 403) {
      return `El proveedor rechazó las credenciales (HTTP ${status}). Verifica que sean de esta cuenta y que no hayan sido rotadas.`;
    }
    if (status === 404) {
      return `El proveedor respondió 404. Revisa el identificador de la cuenta (dominio o Business ID).`;
    }
    if (status === 429) {
      return "El proveedor está limitando peticiones (HTTP 429). Reintenta en unos minutos.";
    }
    return `El proveedor respondió HTTP ${status}.`;
  }
  if (err instanceof Error && err.name === "AbortError") {
    return "La petición al proveedor expiró (timeout).";
  }
  return "No se pudo contactar al proveedor. Revisa la configuración y reintenta.";
}

interface ShopInfo {
  shop?: { name?: string; myshopify_domain?: string; plan_name?: string };
}

async function probeShopify(organizationId: UUID, shopDomain: string | null): Promise<ProbeResult> {
  if (!shopDomain) {
    return { ok: false, message: "Falta el dominio de la tienda.", details: [] };
  }
  const res = await shopifyRest<ShopInfo>(
    { organizationId, shopDomain },
    "GET",
    "/shop.json",
  );
  const shop = res?.shop;
  if (!shop?.myshopify_domain) {
    return { ok: false, message: "Shopify respondió sin datos de la tienda.", details: [] };
  }
  // Defensa contra "credenciales correctas, tienda equivocada": el token es
  // per-shop, así que un desajuste aquí significa que el dominio guardado no
  // es el de la tienda que realmente respondió.
  if (shop.myshopify_domain.toLowerCase() !== shopDomain.toLowerCase()) {
    return {
      ok: false,
      message: `La tienda que respondió es ${shop.myshopify_domain}, no ${shopDomain}. Corrige el dominio.`,
      details: [],
    };
  }
  return {
    ok: true,
    message: "Conexión verificada con Shopify.",
    details: [
      `Tienda: ${shop.name ?? shop.myshopify_domain}`,
      `Dominio: ${shop.myshopify_domain}`,
      ...(shop.plan_name ? [`Plan: ${shop.plan_name}`] : []),
    ],
  };
}

async function probeWhaapyVenta(organizationId: UUID): Promise<ProbeResult> {
  const team = await listWhaapyTeam({ organizationId });
  const named = team.filter((a) => a.name).length;
  return {
    ok: true,
    message: "Conexión verificada con Whaapy Venta.",
    details: [
      `Agentes visibles: ${team.length}`,
      ...(named > 0
        ? [`Ejemplos: ${team.slice(0, 3).map((a) => a.name ?? a.id).join(", ")}`]
        : []),
    ],
  };
}

interface StagesResponse {
  stages?: Array<{ id?: string; name?: string }>;
}

/**
 * Nombres del funnel remoto tal cual vinieron, entrecomillados. El match de
 * etapas es por igualdad EXACTA de string (ver `resolvePostventaStageIdByKey`),
 * así que el admin necesita ver acentos, mayúsculas y espacios de más para
 * distinguir "no existe" de "se llama casi igual". Sin esto, "Etapas
 * encontradas: 4" obliga a correr un script para diagnosticar lo que la
 * tarjeta ya tenía en la mano. No son secretos: son nombres de funnel, la
 * misma clase de dato que los agentes que ya lista el probe de Venta.
 */
function formatStageNames(names: string[]): string {
  if (names.length === 0) return "ninguna";
  const MAX = 8;
  const shown = names.slice(0, MAX).map((n) => `"${n}"`).join(", ");
  return names.length > MAX ? `${shown}, +${names.length - MAX} más` : shown;
}

async function probeWhaapyPostventa(organizationId: UUID): Promise<ProbeResult> {
  const res = await whaapyPostventaRest<StagesResponse>(
    organizationId,
    "GET",
    "/funnel/v1/stages",
  );
  const names = (res?.stages ?? []).map((s) => s?.name).filter((n): n is string => !!n);
  // El contrato con esta instancia no es solo "responde": la plataforma mueve
  // contactos a etapas resueltas POR NOMBRE. Un rename del lado de Whaapy deja
  // la integración muda sin ningún otro síntoma, así que el probe lo verifica.
  const expected = Object.values(WHAAPY_POSTVENTA_STAGE_NAMES);
  const missing = expected.filter((n) => !names.includes(n));
  if (missing.length > 0) {
    return {
      ok: false,
      message: `Conecta, pero faltan etapas con el nombre exacto: ${missing.join(", ")}. Créalas o renómbralas en Whaapy (el match es por nombre exacto: acentos y mayúsculas cuentan) o la sincronización de post-venta queda muda.`,
      details: [
        `Etapas encontradas (${names.length}): ${formatStageNames(names)}`,
      ],
    };
  }
  return {
    ok: true,
    message: "Conexión verificada con Whaapy Post-venta.",
    details: [
      `Etapas del funnel (${names.length}): ${formatStageNames(names)}`,
      `Etapas requeridas presentes: ${expected.join(", ")}`,
    ],
  };
}

export async function probeIntegration(input: {
  organizationId: UUID;
  provider: IntegrationProvider;
  shopDomain: string | null;
}): Promise<ProbeResult> {
  try {
    switch (input.provider) {
      case "shopify":
        return await probeShopify(input.organizationId, input.shopDomain);
      case "whaapy_venta":
        return await probeWhaapyVenta(input.organizationId);
      case "whaapy_postventa":
        return await probeWhaapyPostventa(input.organizationId);
    }
  } catch (err) {
    return { ok: false, message: truncate(describeError(err)), details: [] };
  }
}
