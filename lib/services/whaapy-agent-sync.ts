import type { UUID } from "@/lib/types/database";

/**
 * Decisión PURA del sync agente-Whaapy → asesor-plataforma para el worker
 * `contact.updated` (dirección Whaapy→plataforma en contactos existentes).
 * Testeable sin BD ni Inngest.
 *
 * Invariantes:
 *   - Sólo actúa si el AGENTE cambió en Whaapy (`agentFieldChanged`, derivado
 *     de `updated_fields.includes("assignedAgentId")`). Un cambio de otro
 *     campo NO toca al asesor.
 *   - Agente presente + mapeado a un vendedor → SET/CHANGE al asesor mapeado.
 *   - Agente presente pero SIN vendedor mapeado → NO cambia el asesor (no se
 *     puede resolver) + señal `mapping_missing` para que el admin lo mapee;
 *     nunca borra un asesor válido por falta de mapeo.
 *   - Agente removido en Whaapy (null) → CLEAR (desasigna en la plataforma).
 *   - Idempotente: si el valor destino == el actual, `changed=false`.
 * R2 intacto: esto sólo decide el asesor del CONTACTO, nunca de la opp. El
 * caller corre esta decisión DESPUÉS de las defensas de eco (R11), así que
 * sólo cambios genuinos de Whaapy llegan — no hay bucle.
 */
export interface AgentAdvisorSyncDecision {
  /** True si `assigned_advisor_id` del contacto debe cambiar. */
  changed: boolean;
  /** Valor a aplicar cuando `changed` (membership o null para desasignar). */
  nextAdvisorId: UUID | null;
  /** Qué auditar: 'synced' (set/clear efectivo), 'mapping_missing', o null. */
  audit: "synced" | "mapping_missing" | null;
}

export function decideAgentAdvisorSync(opts: {
  /** `updated_fields` del webhook incluye "assignedAgentId". */
  agentFieldChanged: boolean;
  /** Agente actual en Whaapy (del snapshot del GET); null = sin agente. */
  snapshotAgentId: string | null;
  /** Asesor actual del contacto en la plataforma. */
  currentAdvisorId: UUID | null;
  /** Membership mapeado desde `snapshotAgentId` (null si no mapea o no aplica). */
  mappedMembershipId: UUID | null;
}): AgentAdvisorSyncDecision {
  const keep: AgentAdvisorSyncDecision = {
    changed: false,
    nextAdvisorId: opts.currentAdvisorId,
    audit: null,
  };
  if (!opts.agentFieldChanged) return keep;

  if (opts.snapshotAgentId) {
    if (!opts.mappedMembershipId) {
      // Agente sin vendedor mapeado — no tocamos el asesor, sólo señalamos.
      return { ...keep, audit: "mapping_missing" };
    }
    if (opts.currentAdvisorId === opts.mappedMembershipId) return keep;
    return { changed: true, nextAdvisorId: opts.mappedMembershipId, audit: "synced" };
  }

  // Agente removido en Whaapy → desasignar (si había algo que quitar).
  if (opts.currentAdvisorId === null) return keep;
  return { changed: true, nextAdvisorId: null, audit: "synced" };
}
