import "server-only";
import { findOrderByShopifyOrderId } from "@/lib/db/orders";

/**
 * Referencia del pedido tal como el CLIENTE la conoce (`#1759`).
 *
 * `opportunities.display_reference` guarda la referencia del **Draft Order**
 * (`#D903`), que es interna: el cliente nunca la vio, su confirmación de
 * compra trae la del pedido. Mandarle el folio del borrador en un mensaje le
 * muestra un número que no reconoce — el mismo malentendido que reportó
 * Post-venta al buscar casos por número.
 *
 * Devuelve null si la opp no tiene orden enlazada o la orden no está en la
 * base: **preferimos una variable vacía a un número equivocado**. El caller
 * audita ese caso para que sea visible sin esperar a que un cliente pregunte.
 *
 * Compartido por los dos caminos que mandan mensaje (Venta al entregar y
 * Post-venta), para que no puedan divergir en qué número muestran.
 */
export async function resolveCustomerFacingOrderRef(
  shopifyOrderId: string | null,
): Promise<string | null> {
  if (!shopifyOrderId) return null;
  const order = await findOrderByShopifyOrderId(shopifyOrderId);
  const name = order?.shopify_name?.trim();
  return name && name.length > 0 ? name : null;
}

/**
 * Valor listo para una VARIABLE de template de WhatsApp: sin el `#`.
 *
 * Las plantillas aprobadas traen el símbolo en el texto fijo
 * (`tu pedido #{{2}} ha sido entregado`), así que pasar `#1759` renderiza
 * `pedido ##1759`. El `#` es del template, no del dato.
 *
 * Se separa de `resolveCustomerFacingOrderRef` a propósito: ahí `#1759` es
 * la forma canónica (la que se ve en Shopify y en la plataforma). Esta
 * normalización aplica SOLO al cruzar hacia un parámetro de template.
 */
export function toTemplateOrderParam(ref: string | null): string | null {
  if (!ref) return null;
  const stripped = ref.trim().replace(/^#+/, "");
  return stripped.length > 0 ? stripped : null;
}
