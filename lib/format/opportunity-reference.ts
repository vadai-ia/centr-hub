/**
 * Qué folio se le muestra al usuario en una oportunidad.
 *
 * `opportunities.display_reference` guarda la referencia del **Draft Order**
 * (`#D1205`): es interna de Shopify y el cliente nunca la vio. El folio que
 * el cliente y Post-venta reconocen es el del **pedido** (`#1828`), que vive
 * en `orders.shopify_name` y llega a la opp como `order_reference` (lo
 * resuelve la capa de datos por `shopify_order_id`).
 *
 * Regla: manda el pedido cuando existe; el borrador es el respaldo para las
 * Cotizaciones que todavía no se convirtieron en pedido. El borrador NO se
 * tira — se sigue mostrando como dato secundario donde hay espacio (detalle)
 * para no perder la trazabilidad al Draft.
 *
 * Módulo PURO y sin `server-only` a propósito: lo comparten los Server
 * Components de la búsqueda y las cards `'use client'` del kanban, y así no
 * pueden divergir en qué número enseñan. El mismo criterio que aplica
 * `lib/services/order-reference.ts` para los mensajes de WhatsApp.
 */

export interface OpportunityReferenceInput {
  /** Folio del pedido (`#1828`), resuelto desde `orders.shopify_name`. */
  order_reference?: string | null;
  /** Folio del Draft Order (`#D1205`), tal como está en la opp. */
  display_reference?: string | null;
}

export interface OpportunityReferences {
  /** El folio a mostrar. Null si la opp no tiene ninguno (lead manual). */
  primary: string | null;
  /**
   * Folio del borrador SOLO cuando es distinto del primario (es decir,
   * cuando ya hay pedido). Null si el primario ya es el borrador — así el
   * caller nunca pinta el mismo número dos veces.
   */
  draft: string | null;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function opportunityReferences(
  opp: OpportunityReferenceInput,
): OpportunityReferences {
  const order = clean(opp.order_reference);
  const draft = clean(opp.display_reference);
  if (!order) return { primary: draft, draft: null };
  return { primary: order, draft: draft && draft !== order ? draft : null };
}

/** Atajo para las superficies compactas (card, lista): solo el primario. */
export function primaryOpportunityReference(
  opp: OpportunityReferenceInput,
): string | null {
  return opportunityReferences(opp).primary;
}
