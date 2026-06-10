import "server-only";
import {
  listUnassignedVentaOppIdsWithOrder,
  listPostventaChildOppIdsForReconcile,
} from "@/lib/db/opportunities";
import {
  reattributeVentaOpportunityAdvisor,
  reattributePostventaChildAdvisor,
} from "@/lib/services/f1-to-f2-trigger";
import type { UUID } from "@/lib/types/database";

/**
 * Reconciliación de atribución de asesor — RED DE SEGURIDAD (lección del
 * "endpoint silencioso" de Whaapy: un webhook perdido deja el estado
 * desincronizado sin error visible).
 *
 * Re-corre los MISMOS RPC que los hooks en vivo de orders/* (0022/0023) y
 * que los correctivos de mantenimiento, garantizando semántica idéntica:
 *   - Venta: rellena el asesor de opps de Venta SIN asesor desde su
 *     pedido enlazado (solo NULL — nunca pisa tag de draft ni manual).
 *   - Post-venta: alinea el asesor de cada hija con el de su orden
 *     (respeta la guarda anti-reasignación-manual).
 *
 * Ambos RPC son idempotentes: si ya está alineado, noop. Por eso correr
 * esto cada hora es seguro y barato — solo escribe cuando hay deriva real
 * (webhook perdido, carrera draft/orden no cerrada en vivo).
 *
 * DEBE invocarse dentro de `withTenantContext` (usa getTenantScopedClient
 * a través de las funciones de datos y los RPC).
 */

export interface AdvisorReconcileVentaItem {
  opportunityId: UUID;
  orderShopifyOrderId: string | null;
  toAdvisorId: UUID | null;
}

export interface AdvisorReconcileChildItem {
  childId: UUID;
  orderShopifyOrderId: string | null;
  fromAdvisorId: UUID | null;
  toAdvisorId: UUID | null;
}

export interface AdvisorReconcileResult {
  ventaCandidates: number;
  childCandidates: number;
  /** Opps/hijas que cambiarían (dry-run) o cambiaron (live). */
  ventaChanged: AdvisorReconcileVentaItem[];
  childChanged: AdvisorReconcileChildItem[];
}

export async function reconcileAdvisorAttribution(opts: {
  dryRun: boolean;
  source: string;
}): Promise<AdvisorReconcileResult> {
  const ventaIds = await listUnassignedVentaOppIdsWithOrder();
  const childIds = await listPostventaChildOppIdsForReconcile();

  const ventaChanged: AdvisorReconcileVentaItem[] = [];
  for (const id of ventaIds) {
    const r = await reattributeVentaOpportunityAdvisor(id, opts.dryRun, opts.source);
    if (r.status === "fixed" || r.status === "would_fix") {
      ventaChanged.push({
        opportunityId: id,
        orderShopifyOrderId: r.orderShopifyOrderId ?? null,
        toAdvisorId: r.toAdvisorId ?? null,
      });
    }
  }

  const childChanged: AdvisorReconcileChildItem[] = [];
  for (const id of childIds) {
    const r = await reattributePostventaChildAdvisor(id, opts.dryRun, opts.source);
    if (r.status === "fixed" || r.status === "would_fix") {
      childChanged.push({
        childId: id,
        orderShopifyOrderId: r.orderShopifyOrderId ?? null,
        fromAdvisorId: r.fromAdvisorId ?? null,
        toAdvisorId: r.toAdvisorId ?? null,
      });
    }
  }

  return {
    ventaCandidates: ventaIds.length,
    childCandidates: childIds.length,
    ventaChanged,
    childChanged,
  };
}
