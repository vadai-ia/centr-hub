import "server-only";
import { customerFunctions } from "./customers";
import { draftOrderFunctions } from "./draft-orders";
import { orderFunctions } from "./orders";
import { dlqFunctions } from "./dlq";
import { whaapyContactFunctions } from "./whaapy-contacts";
import { whaapyConversationFunctions } from "./whaapy-conversations";
import { whaapyOutboundFunctions } from "./whaapy-outbound";
import { shopifyOutboundFunctions } from "./shopify-outbound";
import { tagReprocessFunctions } from "./tag-reprocess";

/**
 * Registro completo de funciones Inngest para servir desde
 * `/api/inngest`.
 *
 * M3 (Shopify): customers, draft-orders, orders, dlq, outbound (M6 — B8).
 * M4 (Whaapy):  contact.*, conversation.*, outbound.
 */
export const allFunctions = [
  ...customerFunctions,
  ...draftOrderFunctions,
  ...orderFunctions,
  ...dlqFunctions,
  ...whaapyContactFunctions,
  ...whaapyConversationFunctions,
  ...whaapyOutboundFunctions,
  ...shopifyOutboundFunctions,
  ...tagReprocessFunctions,
];
