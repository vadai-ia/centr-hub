import "server-only";
import { whaapyRest } from "@/lib/whaapy/admin-client";
import {
  WHAAPY_OUTBOUND_MARKER_FIELD,
  WHAAPY_VENTA_STAGE_NAMES,
  type WhaapyVentaStageKey,
} from "@/lib/whaapy/config";
import type { UUID } from "@/lib/types/database";

/**
 * Funnel del Whaapy de VENTA — mover contactos de etapa para disparar sus
 * Automations.
 *
 * Por qué existe: Whaapy no tiene disparador por etiqueta ni con retraso.
 * `pipeline_stage_entered` es el ÚNICO trigger que la plataforma puede
 * accionar, así que "mandar un mensaje desde el número de Venta" se traduce
 * en "mover el contacto a una etapa del funnel de Venta".
 *
 * Espejo de `lib/whaapy-postventa/api.ts`, con dos diferencias que importan:
 *
 *  1. **El contact_id ya lo tenemos.** Venta es la instancia maestra: su id
 *     vive en `contacts.whaapy_contact_id`. No hace falta buscar por
 *     teléfono como en Post-venta (instancia independiente).
 *
 *  2. **Esta instancia SÍ tiene webhooks suscritos.** Todo PATCH de aquí
 *     rebota como `contact.updated`. Por eso el marker R11
 *     (`last_platform_write_at`) es OBLIGATORIO en cada escritura — es lo
 *     que hace que el worker entrante lo descarte como eco propio en vez de
 *     re-procesarlo. Post-venta no lo necesitaba porque ahí no hay webhooks.
 */

// ============================================================
// Stage resolver por nombre (caché en memoria, best-effort)
// ============================================================

interface StageCacheEntry {
  byName: Map<string, string>;
  fetchedAtMs: number;
}

const STAGE_CACHE = new Map<UUID, StageCacheEntry>();
const STAGE_CACHE_TTL_MS = 10 * 60 * 1000;

interface WhaapyStagesResponse {
  stages?: Array<{ id?: string; name?: string; position?: number }>;
}

async function loadStageMap(
  organizationId: UUID,
  opts: { forceRefresh?: boolean } = {},
): Promise<Map<string, string>> {
  const cached = STAGE_CACHE.get(organizationId);
  const fresh = cached && Date.now() - cached.fetchedAtMs < STAGE_CACHE_TTL_MS;
  if (cached && fresh && !opts.forceRefresh) return cached.byName;

  const res = await whaapyRest<WhaapyStagesResponse>(
    { organizationId },
    "GET",
    "/funnel/v1/stages",
  );
  const byName = new Map<string, string>();
  for (const s of res?.stages ?? []) {
    if (s?.name && s?.id) byName.set(s.name, s.id);
  }
  STAGE_CACHE.set(organizationId, { byName, fetchedAtMs: Date.now() });
  return byName;
}

/**
 * UUID de la etapa del funnel de VENTA por su clave lógica. Igual que en
 * Post-venta, el match es por nombre EXACTO y se refresca la caché una vez
 * antes de rendirse (cubre "etapa creada después de cachear").
 *
 * Devuelve null si no existe → el caller lo trata como configuración
 * pendiente, no como fallo. En Centr el funnel de Venta arrancó VACÍO, así
 * que null es el estado esperado hasta que se cree la etapa.
 */
export async function resolveVentaStageIdByKey(
  organizationId: UUID,
  key: WhaapyVentaStageKey,
): Promise<string | null> {
  const name = WHAAPY_VENTA_STAGE_NAMES[key];
  let map = await loadStageMap(organizationId);
  let id = map.get(name);
  if (!id) {
    map = await loadStageMap(organizationId, { forceRefresh: true });
    id = map.get(name);
  }
  return id ?? null;
}

// ============================================================
// Contacto: etapa actual + escritura de contexto + move
// ============================================================

interface WhaapyContactResponse {
  contact?: { id?: string; funnel_stage?: { id?: string } | null } | null;
  id?: string;
  funnel_stage?: { id?: string } | null;
}

/**
 * Etapa actual del contacto en el funnel de Venta, o null si no tiene.
 * Sirve para NO re-mover un contacto que ya está en el destino: el trigger
 * de Whaapy es ENTRAR a la etapa, así que un move redundante volvería a
 * disparar la automatización y el cliente recibiría el mensaje dos veces.
 *
 * `GET /contacts/v1/{id}` envuelve en `{contact:{...}}` (ver ERRORES.md);
 * se parsea defensivo con fallback a la forma plana.
 */
export async function getVentaContactStageId(
  organizationId: UUID,
  whaapyContactId: string,
): Promise<string | null> {
  const res = await whaapyRest<WhaapyContactResponse>(
    { organizationId },
    "GET",
    `/contacts/v1/${whaapyContactId}`,
  );
  const stage = res?.contact?.funnel_stage ?? res?.funnel_stage ?? null;
  return stage?.id ?? null;
}

/**
 * Escribe `custom_fields` en el contacto de Venta. SIEMPRE agrega el marker
 * R11 — sin él, el `contact.updated` que rebota se procesaría como si fuera
 * una edición del usuario en Whaapy.
 *
 * Whaapy MERGEA custom_fields, así que esto no borra las claves existentes.
 */
export async function patchVentaContactCustomFields(
  organizationId: UUID,
  whaapyContactId: string,
  customFields: Record<string, string | null>,
): Promise<void> {
  await whaapyRest<unknown>(
    { organizationId },
    "PATCH",
    `/contacts/v1/${whaapyContactId}`,
    {
      custom_fields: {
        ...customFields,
        [WHAAPY_OUTBOUND_MARKER_FIELD]: new Date().toISOString(),
      },
    },
  );
}

/**
 * Mueve el contacto a una etapa del funnel de Venta. Es lo que dispara la
 * Automation `pipeline_stage_entered` — y por lo tanto el mensaje.
 */
export async function moveVentaContactToStage(
  organizationId: UUID,
  whaapyContactId: string,
  stageId: string,
): Promise<void> {
  await whaapyRest<unknown>(
    { organizationId },
    "POST",
    `/funnel/v1/contacts/${whaapyContactId}/move`,
    { stage_id: stageId },
  );
}
