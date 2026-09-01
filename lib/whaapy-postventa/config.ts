import "server-only";

/**
 * Configuración de la integración Post-venta ↔ Whaapy Post-venta.
 *
 * El Whaapy de Post-venta es una instancia INDEPENDIENTE del de Venta.
 * Comparte host (`https://api.whaapy.com`, ver `lib/whaapy/config.ts`) y
 * la forma de la API, pero usa credenciales, businessId, endpoint y
 * namespace de dedup propios. Nada de acá toca el Whaapy de Venta.
 */

/**
 * Nombres EXACTOS de las etapas destino en el funnel del Whaapy de
 * Post-venta (los creó el operador con esta capitalización/acentos). El
 * cliente resuelve el UUID por nombre vía `GET /funnel/v1/stages` (con
 * caché). Si el operador renombra una etapa en Whaapy, actualizar acá.
 *
 * OJO: son los nombres del funnel de WHAAPY, no de las etapas internas de
 * la plataforma — se resuelven contra Whaapy, no contra pipeline_stages.
 */
export const WHAAPY_POSTVENTA_STAGE_NAMES = {
  /** Destino del webhook 1: opp llegó a "Entregado" en la plataforma. */
  entregado: "Entregado",
  /** Destino del webhook 2: opp entró a "Caso problemático". */
  casoProblematico: "Caso Problemático",
  /** Destino del webhook 4 y filtro del webhook 3 entrante (resolución). */
  casoResuelto: "Caso Resuelto",
  /**
   * MENSAJE 2 — seguimiento "7 dias". Lo empuja el cron 7 días después de
   * que salió el mensaje 1 (que va desde el número de VENTA). La Automation
   * de ESTA instancia manda el template, así que el cliente lo recibe del
   * número de post-venta: los dos mensajes salen de números distintos a
   * propósito.
   */
  seguimiento: "Seguimiento post-entrega",
} as const;

export type WhaapyPostventaStageKey = keyof typeof WHAAPY_POSTVENTA_STAGE_NAMES;

/**
 * Claves de `custom_fields` que la plataforma escribe en el contacto de
 * Whaapy Post-venta al empujarlo (webhooks 1 y 2). `centrhub_opportunity_id`
 * es la clave del MATCH INVERSO: el webhook 3 (`contact.stage_changed`, que
 * NO trae la opp) hace un GET del contacto y lee esta clave para resolver la
 * oportunidad exacta — desambigua cuando el contacto tiene varias órdenes.
 * `centrhub_order_ref` es usable en los templates de mensaje de Whaapy.
 */
export const WHAAPY_POSTVENTA_CUSTOM_FIELDS = {
  opportunityId: "centrhub_opportunity_id",
  orderRef: "centrhub_order_ref",
  orderId: "centrhub_order_id",
} as const;

/**
 * Kill switch de las llamadas SALIENTES a Whaapy Post-venta (webhooks
 * 1, 2, 4). Default OFF: sin `POSTVENTA_WHAAPY_SYNC_ENABLED=true` la
 * plataforma no dispara ningún push a Whaapy. Se lee de `process.env`
 * directo (mismo patrón que `isPostventaEngineEnabled`) para que el
 * gate sea trivialmente verificable y togglear en Vercel no requiera
 * redeploy de schema.
 *
 * NOTA: el endpoint ENTRANTE (webhook 3) no se gatea con esto — recibir
 * y validar HMAC es seguro aunque el saliente esté OFF; el anti-bucle
 * vive en la lógica, no en el kill switch.
 */
export function isPostventaWhaapySyncEnabled(): boolean {
  return process.env.POSTVENTA_WHAAPY_SYNC_ENABLED === "true";
}

/**
 * Kill switch del MENSAJE 2 (seguimiento "7 dias"). Independiente del de la
 * sincronización general: es un mensaje de categoría MARKETING que sale solo,
 * por cron, días después de cualquier acción humana — poder apagarlo sin
 * apagar la sincronización de casos es un requisito operativo, no un lujo.
 *
 * Default OFF: el deploy no manda nada hasta que el operador lo habilite.
 */
export function isPostventaFollowupMessageEnabled(): boolean {
  return process.env.POSTVENTA_FOLLOWUP_MESSAGE_ENABLED === "true";
}

/** Días entre el mensaje 1 (entrega) y el 2 (seguimiento). */
export const POSTVENTA_FOLLOWUP_DELAY_DAYS = 7;
