import "server-only";
import { customerFunctions } from "./customers";
import { draftOrderFunctions } from "./draft-orders";
import { orderFunctions } from "./orders";
import { dlqFunctions } from "./dlq";
import { whaapyContactFunctions } from "./whaapy-contacts";
import { whaapyConversationFunctions } from "./whaapy-conversations";
import { whaapyOutboundFunctions } from "./whaapy-outbound";
import { whaapyPostventaFunctions } from "./whaapy-postventa";
import { ventaDeliveryFunctions } from "./venta-delivery";
import { postventaFollowupFunctions } from "./postventa-followup-cron";
import { whaapyPostventaInboundFunctions } from "./whaapy-postventa-inbound";
import { shopifyOutboundFunctions } from "./shopify-outbound";
import { tagReprocessFunctions } from "./tag-reprocess";
import { advisorReconciliationFunctions } from "./advisor-reconciliation";
import { postventaTransitionFunctions } from "./postventa-transition-cron";
import { ruleEvaluationFunctions } from "./rule-evaluation";
import { goalSnapshotFunctions } from "./goal-snapshot";
import { leadWebhookFunctions } from "./lead-webhook";
import { whaapyInboundHealthFunctions } from "./whaapy-inbound-health";

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
  ...whaapyPostventaFunctions,
  ...ventaDeliveryFunctions,
  ...postventaFollowupFunctions,
  ...whaapyPostventaInboundFunctions,
  ...shopifyOutboundFunctions,
  ...tagReprocessFunctions,
  ...advisorReconciliationFunctions,
  ...postventaTransitionFunctions,
  ...ruleEvaluationFunctions,
  ...goalSnapshotFunctions,
  ...leadWebhookFunctions,
  ...whaapyInboundHealthFunctions,
];
