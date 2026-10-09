/**
 * Catálogo de eventos de la bitácora del cliente (punto 24).
 *
 * Módulo PURO: traduce un `audit_log.event_type` a lo que se pinta.
 *
 * **Es una lista blanca a propósito, y eso NO contradice "bitácora
 * completa".** Medido en producción: de 18,857 filas de auditoría, solo el
 * 10% son hechos del negocio; el resto son recibos de webhook
 * (`shopify_webhook_received`: 5,553 filas), ecos descartados
 * (`sync_loop_prevented`), intentos de sincronización y reintentos. Una
 * bitácora literal sepultaría "le mandamos la encuesta" bajo cinco mil
 * recibos de webhook. Lo que se pidió es saber dónde está el cliente, y eso
 * son los hechos, no la plomería.
 *
 * Cada evento nuevo que merezca verse se agrega AQUÍ y en ningún otro lado.
 * Un `event_type` ausente del catálogo simplemente no entra a la bitácora —
 * nunca se pinta con su nombre técnico crudo.
 */

export type TimelineCategory =
  | "identidad"
  | "asignacion"
  | "pipeline"
  | "cotizacion"
  | "mensajes"
  | "atencion";

export const TIMELINE_CATEGORY_LABELS: Record<TimelineCategory, string> = {
  identidad: "Identidad y entrada",
  asignacion: "Asignación",
  pipeline: "Pipeline",
  cotizacion: "Cotizaciones y pedidos",
  mensajes: "Mensajes enviados",
  atencion: "Tareas y notas",
};

/** El orden en que se ofrecen los filtros — de "quién es" a "qué se hizo". */
export const TIMELINE_CATEGORY_ORDER: readonly TimelineCategory[] = [
  "identidad",
  "asignacion",
  "pipeline",
  "cotizacion",
  "mensajes",
  "atencion",
] as const;

export type TimelineKind =
  // --- identidad y entrada ---
  | "lead_created"
  | "contact_edited"
  | "contact_created_in_shopify"
  | "contact_matched_in_shopify"
  | "contact_created_in_whaapy"
  | "identity_linked"
  | "contact_merged"
  | "contact_archived"
  | "contact_weak_identifiers"
  // --- asignación ---
  | "reassignment"
  | "customer_success_assigned"
  | "handoff"
  // --- pipeline ---
  | "stage_change"
  | "opportunity_auto_created"
  | "lead_absorbed"
  | "case_resolved"
  | "postventa_opened"
  // --- cotizaciones y pedidos ---
  | "order_paid"
  | "order_cancelled"
  // --- mensajes que la plataforma envió ---
  | "message_sent"
  | "message_skipped"
  // --- tareas y notas ---
  | "task_created"
  | "task_completed"
  | "manual_note"
  | "lead_message"
  // --- resto ---
  | "other_activity"
  | "other_audit";

type Payload = Record<string, unknown>;

export interface CatalogEntry {
  kind: TimelineKind;
  category: TimelineCategory;
  /** Etiqueta en español. Recibe el payload para poder dar el detalle útil. */
  label: (payload: Payload) => string;
}

const str = (p: Payload, key: string): string | null => {
  const v = p[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
};

const LEAD_SOURCE_LABELS: Record<string, string> = {
  webhook: "formulario web",
  manual: "captura manual",
  whaapy: "WhatsApp",
  shopify: "Shopify",
};

/**
 * El catálogo. Las keys son `audit_log.event_type` exactos — cambiar el
 * string en el emisor sin cambiarlo aquí saca el evento de la bitácora en
 * silencio (lo cubre `tests/timeline-catalog.test.ts`).
 */
export const AUDIT_CATALOG: Record<string, CatalogEntry> = {
  // ---------------- identidad y entrada ----------------
  lead_created: {
    kind: "lead_created",
    category: "identidad",
    label: (p) => {
      const src = str(p, "source");
      const human = src ? LEAD_SOURCE_LABELS[src] ?? src : null;
      return human ? `Lead capturado (${human})` : "Lead capturado";
    },
  },
  whaapy_contact_created_from_conversation: {
    kind: "lead_created",
    category: "identidad",
    label: () => "Entró por una conversación de WhatsApp",
  },
  contact_marked_outbound: {
    kind: "contact_edited",
    category: "identidad",
    label: () => "Marcado como prospección (outbound)",
  },
  contact_without_strong_identifiers: {
    kind: "contact_weak_identifiers",
    category: "identidad",
    label: () => "Entró sin teléfono ni correo — no se pudo cruzar con nadie",
  },
  identity_linked_whaapy: {
    kind: "identity_linked",
    category: "identidad",
    label: () => "Identidad de WhatsApp vinculada",
  },
  whaapy_contact_created_outbound: {
    kind: "contact_created_in_whaapy",
    category: "identidad",
    label: () => "Contacto creado en Whaapy",
  },
  whaapy_contact_matched_existing_on_create: {
    kind: "contact_created_in_whaapy",
    category: "identidad",
    label: () => "Vinculado a un contacto que ya existía en Whaapy",
  },
  shopify_customer_created_outbound: {
    kind: "contact_created_in_shopify",
    category: "identidad",
    label: () => "Cliente creado en Shopify",
  },
  shopify_customer_matched_existing_on_create: {
    kind: "contact_matched_in_shopify",
    category: "identidad",
    label: () => "Vinculado a un cliente que ya existía en Shopify",
  },
  contact_edited_manually: {
    kind: "contact_edited",
    category: "identidad",
    label: (p) => {
      const fields = p.fields;
      return Array.isArray(fields) && fields.length > 0
        ? `Datos editados (${fields.join(", ")})`
        : "Datos editados";
    },
  },
  contact_lead_merged_into_client: {
    kind: "contact_merged",
    category: "identidad",
    label: () => "Ficha duplicada fusionada en este cliente",
  },
  contact_archived_whaapy_deletion: {
    kind: "contact_archived",
    category: "identidad",
    label: () => "Archivado: lo borraron en WhatsApp",
  },

  // ---------------- asignación ----------------
  contact_reassigned: {
    kind: "reassignment",
    category: "asignacion",
    label: () => "Contacto reasignado",
  },
  opportunity_reassigned: {
    kind: "reassignment",
    category: "asignacion",
    label: () => "Oportunidad reasignada a mano",
  },
  opportunity_customer_success_assigned: {
    kind: "customer_success_assigned",
    category: "asignacion",
    label: () => "Customer Success asignado",
  },
  outbound_opportunity_handed_off: {
    kind: "handoff",
    category: "asignacion",
    label: () => "Entregada de prospección a un asesor",
  },
  venta_opportunity_advisor_reattributed: {
    kind: "reassignment",
    category: "asignacion",
    label: () => "Asesor atribuido por la etiqueta del pedido",
  },
  postventa_child_advisor_reattributed: {
    kind: "reassignment",
    category: "asignacion",
    label: () => "Asesor de post-venta heredado de la venta",
  },
  contact_owner_synced_from_opp: {
    kind: "reassignment",
    category: "asignacion",
    label: () => "Asesor del contacto sincronizado con su oportunidad",
  },

  // ---------------- pipeline ----------------
  c2_opportunity_auto_created: {
    kind: "opportunity_auto_created",
    category: "pipeline",
    label: (p) => {
      const trigger = str(p, "trigger");
      if (trigger === "new_contact_in_whaapy") {
        return "Oportunidad creada sola (entró a WhatsApp)";
      }
      if (trigger === "reactivity_after_n_days") {
        return "Oportunidad creada sola (volvió a escribir)";
      }
      return "Oportunidad creada sola";
    },
  },
  online_order_opportunity_created: {
    kind: "opportunity_auto_created",
    category: "pipeline",
    label: () => "Post-venta abierta por una compra en línea",
  },
  lead_nuevo_absorbed_by_advanced_opportunity: {
    kind: "lead_absorbed",
    category: "pipeline",
    label: () => "Lead archivado porque avanzó a cotización",
  },
  trigger_f1_f2_fired: {
    kind: "postventa_opened",
    category: "pipeline",
    label: () => "Post-venta abierta al pagarse el pedido",
  },
  postventa_case_resolved: {
    kind: "case_resolved",
    category: "pipeline",
    label: () => "Caso problemático marcado como resuelto",
  },

  // ---------------- mensajes que la plataforma envió ----------------
  venta_delivery_message_sent: {
    kind: "message_sent",
    category: "mensajes",
    label: () => "WhatsApp enviado: confirmación de entrega",
  },
  postventa_followup_message_sent: {
    kind: "message_sent",
    category: "mensajes",
    label: () => "WhatsApp enviado: encuesta de los 7 días",
  },
  postventa_survey_backfill_sent: {
    kind: "message_sent",
    category: "mensajes",
    label: () => "WhatsApp enviado: encuesta de los 7 días (envío correctivo)",
  },
  venta_delivery_push_skipped: {
    kind: "message_skipped",
    category: "mensajes",
    label: (p) => {
      const reason = str(p, "skip_reason") ?? str(p, "reason");
      const human: Record<string, string> = {
        missing_phone: "no tiene teléfono",
        already_sent: "ya se había enviado",
        contact_not_found: "no se encontró el contacto",
        opportunity_not_found: "no se encontró la oportunidad",
        order_ref_missing: "falta el folio del pedido",
      };
      const why = reason ? human[reason] ?? reason : null;
      return why
        ? `Confirmación de entrega NO enviada (${why})`
        : "Confirmación de entrega NO enviada";
    },
  },
};

/** Categoría de los eventos que NO vienen del audit log. */
const CATEGORY_BY_KIND: Partial<Record<TimelineKind, TimelineCategory>> = {
  stage_change: "pipeline",
  order_paid: "cotizacion",
  order_cancelled: "cotizacion",
  task_created: "atencion",
  task_completed: "atencion",
  manual_note: "atencion",
  lead_message: "atencion",
  other_activity: "atencion",
};

export function categoryOfKind(kind: TimelineKind): TimelineCategory {
  return CATEGORY_BY_KIND[kind] ?? "pipeline";
}

export interface DescribedEvent {
  kind: TimelineKind;
  category: TimelineCategory;
  label: string;
}

/**
 * Describe un evento del audit log, o `null` si no está en el catálogo —
 * lo que significa "no es un hecho del negocio, no va a la bitácora".
 */
export function describeAuditEvent(
  eventType: string,
  payload: Payload,
): DescribedEvent | null {
  const entry = AUDIT_CATALOG[eventType];
  if (!entry) return null;
  return { kind: entry.kind, category: entry.category, label: entry.label(payload) };
}
