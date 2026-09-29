import "server-only";
import { whaapyPostventaRest } from "@/lib/whaapy-postventa/client";
import type { UUID } from "@/lib/types/database";

/**
 * Envío directo de plantilla por la instancia de POST-VENTA.
 *
 * Gemelo de `lib/whaapy/send-template.ts` (Venta) y separado a propósito:
 * son dos WABA distintas, cada una con sus credenciales y sus plantillas
 * aprobadas. Una plantilla de Venta NO existe del lado de Post-venta.
 *
 * El flujo normal de los 7 días sigue saliendo por la Automation de esa
 * instancia (su plantilla solo usa `{{1}}` = nombre, que Whaapy SÍ resuelve).
 * Esto es para los envíos que la plataforma origina, como el correctivo a
 * quienes llegaron a "Seguimiento post-entrega" antes de que existieran los
 * mensajes: mover de etapa no les dispararía nada porque ya están ahí.
 */

export interface SendPostventaTemplateInput {
  to: string;
  templateName: string;
  /** Valores de {{1}}, {{2}}, … EN ORDEN. */
  parameters: string[];
}

export async function sendPostventaTemplate(
  organizationId: UUID,
  input: SendPostventaTemplateInput,
): Promise<void> {
  await whaapyPostventaRest<unknown>(organizationId, "POST", "/messages/v1", {
    to: input.to,
    type: "template",
    templateName: input.templateName,
    template_parameters: input.parameters,
  });
}
