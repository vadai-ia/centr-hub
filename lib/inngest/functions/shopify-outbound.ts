import "server-only";
import {
  getInngestClient,
  SHOPIFY_OUTBOUND_CONTACT_UPDATE_EVENT,
  type ShopifyContactUpdateEnvelope,
} from "@/lib/inngest/client";
import { withTenantContext } from "@/lib/tenant/context";
import {
  updateCustomer,
  syncCustomerDefaultAddress,
  BackfillSuppressedError,
} from "@/lib/shopify/outbound";
import { ShopifyApiError } from "@/lib/shopify/admin-client";
import { getOrganizationById } from "@/lib/db/organizations";
import { recordAuditEvent } from "@/lib/db/operational";
import { parseStoredAddress, structuredAddressToShopify } from "@/lib/contacts/address";

/**
 * Worker outbound Shopify desde edición manual (M6 — B8).
 *
 * Consume `shopify/outbound.contact_update_requested`. Cada vez que
 * el usuario guarda edición de un contacto con `shopify_customer_id`
 * enlazado, la Server Action emite un evento con el snapshot. Este
 * worker:
 *   1. Verifica que la org no esté en backfill (la función outbound
 *      ya lo hace internamente — re-verificamos para abortar barato).
 *   2. Llama a `updateCustomer` con los campos escalares editables
 *      (firstName, lastName, email, phone, note).
 *   3. Sincroniza la dirección por separado con
 *      `syncCustomerDefaultAddress` (endpoint dedicado por `address_id`).
 *      NO se manda en el array `addresses[]` del PUT de customer: eso
 *      apendaba una dirección nueva en vez de actualizar la existente
 *      (Shopify lo trata como alta → duplicado). Ver ERRORES.md
 *      "Edición de dirección desde la plataforma duplicaba la dirección
 *      en Shopify".
 *   4. Si falla con error retriable (429, 5xx) → throw para que
 *      Inngest reintente. Si no es retriable → audit log + return.
 *
 * Defensa anti-bucle (R11): `updateCustomer` invoca `markOutboundWrite`
 * ANTES del PUT, así que el webhook `customers/update` que Shopify
 * emite como eco se descarta en M3 (`discardIfOwnEcho`).
 */

const inngest = getInngestClient();

export const shopifyOutboundContactUpdate = inngest.createFunction(
  {
    id: "shopify-outbound-contact-update",
    retries: 5,
    triggers: [{ event: SHOPIFY_OUTBOUND_CONTACT_UPDATE_EVENT }],
  },
  async ({ event }) => {
    const envelope = event.data as unknown as ShopifyContactUpdateEnvelope;
    return withTenantContext(
      envelope.organizationId,
      async () => {
        const org = await getOrganizationById(envelope.organizationId);
        if (!org) {
          await recordAuditEvent({
            actorUserId: null,
            eventType: "shopify_outbound_failed",
            entityType: "contact",
            entityId: envelope.contactId,
            payload: { reason: "organization_not_found" },
          });
          return { discarded: true, reason: "organization_not_found" };
        }
        const backfill = (org as unknown as { backfill_in_progress?: boolean })
          .backfill_in_progress;
        if (backfill === true) {
          await recordAuditEvent({
            actorUserId: null,
            eventType: "shopify_outbound_suppressed_backfill",
            entityType: "contact",
            entityId: envelope.contactId,
            payload: { reason: envelope.reason },
          });
          return { discarded: true, reason: "backfill_in_progress" };
        }
        const shopDomain = org.shopify_store_domain;
        if (!shopDomain) {
          await recordAuditEvent({
            actorUserId: null,
            eventType: "shopify_outbound_failed",
            entityType: "contact",
            entityId: envelope.contactId,
            payload: { reason: "shop_domain_missing" },
          });
          return { discarded: true, reason: "shop_domain_missing" };
        }

        const { fullName, email, phone, internalNote, shopifyCustomerId, address } =
          envelope.contactSnapshot;
        const { first, last } = splitName(fullName);

        // Mapea la dirección estructurada del maestro al Address de
        // Shopify (claves coinciden). Si está vacía → null → la sync de
        // dirección es no-op (no se pisa la dirección existente).
        const shopifyAddress = structuredAddressToShopify(
          parseStoredAddress(address),
          phone,
        );

        try {
          await updateCustomer({
            ctx: { organizationId: envelope.organizationId, shopDomain },
            contactId: envelope.contactId,
            shopifyCustomerId,
            fields: {
              first_name: first,
              last_name: last,
              email,
              phone,
              note: internalNote,
            },
          });
          // Dirección por su propio recurso (address_id resuelto vía
          // GET) — NUNCA en el array del PUT de customer (apendaría).
          await syncCustomerDefaultAddress({
            ctx: { organizationId: envelope.organizationId, shopDomain },
            contactId: envelope.contactId,
            shopifyCustomerId,
            address: shopifyAddress,
          });
          return { contactId: envelope.contactId, shopifyCustomerId };
        } catch (e) {
          if (e instanceof BackfillSuppressedError) {
            await recordAuditEvent({
              actorUserId: null,
              eventType: "shopify_outbound_suppressed_backfill",
              entityType: "contact",
              entityId: envelope.contactId,
              payload: { reason: envelope.reason },
            });
            return { discarded: true, reason: "backfill_suppressed" };
          }
          if (e instanceof ShopifyApiError) {
            if (e.retriable) {
              await recordAuditEvent({
                actorUserId: null,
                eventType: "shopify_outbound_retry",
                entityType: "contact",
                entityId: envelope.contactId,
                payload: { status: e.status },
              });
              throw e;
            }
            await recordAuditEvent({
              actorUserId: null,
              eventType: "shopify_outbound_failed",
              entityType: "contact",
              entityId: envelope.contactId,
              payload: { reason: "shopify_api_error", status: e.status },
            });
            return { discarded: true, reason: "shopify_api_error" };
          }
          await recordAuditEvent({
            actorUserId: null,
            eventType: "shopify_outbound_failed",
            entityType: "contact",
            entityId: envelope.contactId,
            payload: {
              reason: "unknown",
              error: e instanceof Error ? e.message : String(e),
            },
          });
          throw e;
        }
      },
      { source: "worker" },
    );
  },
);

function splitName(full: string | null): {
  first: string | null;
  last: string | null;
} {
  if (!full) return { first: null, last: null };
  const trimmed = full.trim();
  if (!trimmed) return { first: null, last: null };
  const idx = trimmed.indexOf(" ");
  if (idx === -1) return { first: trimmed, last: null };
  return {
    first: trimmed.slice(0, idx),
    last: trimmed.slice(idx + 1).trim() || null,
  };
}

export const shopifyOutboundFunctions = [shopifyOutboundContactUpdate];
