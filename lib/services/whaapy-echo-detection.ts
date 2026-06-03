import "server-only";
import { WHAAPY_OUTBOUND_MARKER_FIELD } from "@/lib/whaapy/config";

/**
 * R11 opción A — marker en `custom_fields` del payload o snapshot.
 *
 * El outbound a Whaapy escribe `custom_fields.last_platform_write_at`
 * con un timestamp en cada POST/PATCH (ver `lib/inngest/functions/whaapy-outbound.ts`).
 * Cualquier webhook entrante que traiga ese marker dentro de la ventana
 * configurada hacia atrás es eco de nuestra propia escritura.
 *
 * Usado en dos sitios:
 *   - `contact.updated` — el GET de reconciliación trae `custom_fields`
 *     en el snapshot.
 *   - `contact.created` — el payload mismo del webhook trae
 *     `custom_fields` (validado por `WhaapyContactCreatedPayloadSchema`).
 *     Sin GET extra: el primer webhook ya basta para detectar el eco.
 *
 * Ventana 5 min: margen para latencia de round-trip outbound → Whaapy
 * → webhook + posibles reintentos de Inngest. Más amplia que la
 * ventana 30 s de la opción B (timestamp local) por la latencia extra.
 */
const ECHO_WINDOW_MS = 5 * 60 * 1000;

export function isEchoByCustomFieldMarker(
  customFields: unknown,
  receivedAt: string,
): boolean {
  if (!customFields || typeof customFields !== "object") return false;
  const raw = (customFields as Record<string, unknown>)[
    WHAAPY_OUTBOUND_MARKER_FIELD
  ];
  if (typeof raw !== "string") return false;
  const markerTs = new Date(raw).getTime();
  if (!Number.isFinite(markerTs)) return false;
  const receivedTs = new Date(receivedAt).getTime();
  if (!Number.isFinite(receivedTs)) return false;
  const deltaMs = receivedTs - markerTs;
  return deltaMs >= 0 && deltaMs <= ECHO_WINDOW_MS;
}

export function readEchoMarker(customFields: unknown): string | null {
  if (!customFields || typeof customFields !== "object") return null;
  const raw = (customFields as Record<string, unknown>)[
    WHAAPY_OUTBOUND_MARKER_FIELD
  ];
  return typeof raw === "string" ? raw : null;
}

export { WHAAPY_OUTBOUND_MARKER_FIELD };
