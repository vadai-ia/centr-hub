import "server-only";
import { whaapyRest } from "@/lib/whaapy/admin-client";
import type { UUID } from "@/lib/types/database";

/**
 * Envío DIRECTO de una plantilla de WhatsApp desde la plataforma.
 *
 * Por qué existe: la vía anterior era indirecta — la plataforma escribía el
 * nº de pedido en un `custom_field` del contacto, lo movía de etapa, y una
 * Automation de Whaapy mandaba la plantilla leyendo ese campo. **Whaapy no
 * resuelve campos personalizados en las variables de plantilla**: su
 * catálogo se limita a `contact.name/first_name/last_name/phone/email`,
 * `business.*` y `system.*`. La Automation abortaba con "La variable
 * {{contact.custom_fields.centrhub_order_ref}} no tiene valor" y NO dejaba
 * ni mensaje fallido en la conversación — cuatro ejecuciones sin un solo
 * envío, invisibles salvo en su log interno.
 *
 * Verificado en producción: con un valor fijo en esa variable, la misma
 * Automation entrega en segundos. El problema nunca fue la WABA, la
 * plantilla ni Meta — era el único dato que la Automation no podía leer.
 *
 * Aquí la plataforma manda los parámetros ya resueltos, así que el folio
 * sale siempre correcto y el fallo llega como excepción (Inngest reintenta)
 * en vez de perderse en un log ajeno.
 *
 * Requiere que la api_key tenga scope de **mensajes/plantillas** — la
 * original se generó sin él a propósito (ver CLAUDE.md, "Scopes de Whaapy").
 */

/** Plantilla aprobada en la WABA de VENTA (Meta: el nombre es inmutable). */
export const VENTA_DELIVERY_TEMPLATE = "confirmacion_pedio_entregado" as const;

export interface SendTemplateInput {
  /** Teléfono en E.164 (+52...), el mismo formato que usa el resto de M4. */
  to: string;
  /** Nombre EXACTO de la plantilla en Meta. */
  templateName: string;
  /**
   * Valores de {{1}}, {{2}}, … EN ORDEN. Meta rechaza el envío si falta
   * alguno, así que el caller resuelve todos antes de llamar.
   */
  parameters: string[];
}

/**
 * Manda la plantilla por la instancia de VENTA.
 *
 * Lanza `WhaapyApiError` ante cualquier fallo HTTP: el caller corre dentro
 * de un worker de Inngest, que reintenta y termina en DLQ. Un envío que
 * falla en silencio es justo lo que este cambio vino a eliminar.
 */
export async function sendVentaTemplate(
  organizationId: UUID,
  input: SendTemplateInput,
): Promise<void> {
  await whaapyRest<unknown>({ organizationId }, "POST", "/messages/v1", {
    to: input.to,
    type: "template",
    templateName: input.templateName,
    template_parameters: input.parameters,
  });
}
