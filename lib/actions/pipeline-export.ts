"use server";

import { getSession } from "@/lib/auth/session";
import { canSeeAllData } from "@/lib/auth/capabilities";
import { withTenantContext } from "@/lib/tenant/context";
import { getOrganizationById } from "@/lib/db/organizations";
import {
  listKanbanOpportunities,
  listCurrentStageEntryAt,
  countKanbanOpportunitiesByStage,
} from "@/lib/db/opportunities";
import { listPipelineStages } from "@/lib/db/pipeline";
import { getMembership, listActiveRealVendors } from "@/lib/db/users";
import { readOrganizationCurrency } from "@/lib/services/organization-currency";
import { readOrganizationTimezone } from "@/lib/services/organization-timezone";
import {
  computeClosedCutoffIso,
  computeClosedListRetentionCutoffIso,
  closedFilterForStage,
  partitionClosedStages,
  readHideClosedDays,
  readPipelineMinDateIso,
} from "@/lib/services/pipeline-visibility";
import type { PipelineExportData } from "@/lib/export/pipeline-export";
import type { Funnel, UUID } from "@/lib/types/database";
import type { Channel } from "@/lib/types/dashboard";

/**
 * Exportación del tablero a Excel — lado servidor.
 *
 * Devuelve DATOS, no un archivo: el `.xlsx` lo arma el navegador, igual que
 * la exportación del Dashboard. Así la librería pesada no entra al bundle del
 * servidor y la función no se acerca al límite de duración de Vercel free
 * teniendo que serializar un libro de varias hojas.
 *
 * El recorte por vendedor NO es cosmético: se resuelve aquí, con las mismas
 * reglas que `loadInitialPipelineState`. Un vendedor exporta solo su cartera
 * y el funnel Outbound le está vedado — si el recorte viviera en la UI,
 * bastaría llamar la action a mano para bajarse el pipeline completo.
 */

/** Tope por etapa. Circuit breaker, no paginación: avisa en vez de mentir. */
const MAX_POR_ETAPA = 2000;

export interface ExportPipelineInput {
  funnel: Funnel;
  /** Mismos filtros que la barra del tablero, para que el archivo coincida. */
  advisorId?: UUID | null;
  unassignedOnly?: boolean;
  query?: string;
  channel?: Channel;
  customerSuccessId?: UUID | null;
  resolvedScope?: "active" | "resolved";
}

export type ExportPipelineResult =
  | { ok: true; data: PipelineExportData }
  | { ok: false; reason: string; message: string };

export async function exportPipelineAction(
  input: ExportPipelineInput,
): Promise<ExportPipelineResult> {
  const session = await getSession();
  if (session.status !== "ok") {
    return { ok: false, reason: "no_session", message: "Sesión expirada." };
  }
  const orgId = session.data.activeOrg.id;
  const isAdmin = canSeeAllData(session.data.activeRole);

  // Mismo gate que el tablero: Outbound solo para roles con data_scope='all'.
  if (input.funnel === "outbound" && !isAdmin) {
    return {
      ok: false,
      reason: "forbidden_funnel",
      message: "No tienes acceso a este funnel.",
    };
  }

  return withTenantContext(orgId, async () => {
    let effectiveAdvisorId: UUID | null | undefined;
    if (!isAdmin) {
      const membership = await getMembership(session.data.userId, orgId);
      if (!membership) {
        return {
          ok: false,
          reason: "no_membership",
          message: "No tienes acceso a esta organización.",
        } as const;
      }
      // Un vendedor exporta lo SUYO, pase lo que pase en el input.
      effectiveAdvisorId = membership.id;
    } else if (input.advisorId) {
      effectiveAdvisorId = input.advisorId;
    } else if (input.unassignedOnly) {
      effectiveAdvisorId = null;
    } else {
      effectiveAdvisorId = undefined;
    }

    const isPostventa = input.funnel === "post_venta";
    const [allStages, vendors, org] = await Promise.all([
      listPipelineStages(input.funnel),
      listActiveRealVendors(orgId),
      getOrganizationById(orgId),
    ]);
    const stages = allStages.filter((s) => s.is_active);
    const nombreAsesor = new Map(
      vendors.map((v) => [v.id as UUID, v.profile.full_name ?? "(sin nombre)"]),
    );

    const cutoffIso = computeClosedCutoffIso(readHideClosedDays(org?.config ?? null));
    const retentionCutoffIso = computeClosedListRetentionCutoffIso();
    const minEffectiveIso = readPipelineMinDateIso(org?.config ?? null);
    const resolvedScope = isPostventa ? input.resolvedScope : undefined;

    // Cuántas quedan FUERA por el auto-ocultar de cerradas. Una hoja
    // "Ganada" vacía donde hay cientos de ganadas se lee como un fallo del
    // archivo; decir el número lo convierte en un dato.
    const { wonStageIds, lostStageIds } = partitionClosedStages(stages);
    const conteos = await countKanbanOpportunitiesByStage({
      funnel: input.funnel,
      assignedAdvisorId: effectiveAdvisorId,
      query: input.query,
      closedHide: { cutoffIso, retentionCutoffIso, wonStageIds, lostStageIds },
      resolvedScope,
      resolvedSinceIso: resolvedScope === "resolved" ? retentionCutoffIso : null,
      minEffectiveIso,
      channel: input.channel,
      customerSuccessId: isPostventa ? input.customerSuccessId ?? undefined : undefined,
    });

    const porEtapa = await Promise.all(
      stages.map(async (stage) => {
        const items = await listKanbanOpportunities({
          funnel: input.funnel,
          stageId: stage.id,
          assignedAdvisorId: effectiveAdvisorId,
          query: input.query,
          limit: MAX_POR_ETAPA,
          // Las mismas reglas de visibilidad del tablero: una exportación que
          // trae lo que la pantalla oculta es la queja "la data no coincide".
          closedFilter: closedFilterForStage(stage, cutoffIso),
          resolvedScope,
          resolvedSinceIso: resolvedScope === "resolved" ? retentionCutoffIso : null,
          minEffectiveIso,
          channel: input.channel,
          customerSuccessId: isPostventa ? input.customerSuccessId ?? undefined : undefined,
        });
        return { stage, items };
      }),
    );

    const todas = porEtapa.flatMap((e) =>
      e.items.map((o) => ({ id: o.id as UUID, stage_id: o.stage_id as UUID })),
    );
    const entroEn = await listCurrentStageEntryAt(todas);

    const data: PipelineExportData = {
      organizationName: session.data.activeOrg.name,
      funnel: input.funnel,
      currency: readOrganizationCurrency(org?.config ?? null),
      timezone: readOrganizationTimezone(org?.config ?? null),
      generatedAt: new Date().toISOString(),
      // Lo que el archivo NO trae, dicho en el archivo: sin esto, un vendedor
      // que exporta y ve menos filas que su jefe cree que algo falla.
      scopeNote: isAdmin
        ? effectiveAdvisorId === null
          ? "Solo oportunidades sin asesor"
          : effectiveAdvisorId
            ? `Solo de ${nombreAsesor.get(effectiveAdvisorId) ?? "un asesor"}`
            : null
        : "Solo tus oportunidades",
      truncated: porEtapa.some((e) => e.items.length >= MAX_POR_ETAPA),
      stages: porEtapa.map(({ stage, items }) => ({
        name: stage.name,
        hiddenClosed: conteos.hiddenCounts[stage.id] ?? 0,
        rows: items.map((o) => ({
          contacto: o.contact?.full_name ?? "(sin contacto)",
          telefono: o.contact?.phone ?? "",
          email: o.contact?.email ?? "",
          asesor: o.assigned_advisor_id
            ? nombreAsesor.get(o.assigned_advisor_id as UUID) ?? ""
            : "Sin asignar",
          monto: o.actual_amount ?? o.estimated_amount ?? null,
          entroEtapaIso: entroEn.get(o.id as UUID) ?? null,
          cotizacion: o.shopify_draft_order_id ?? "",
          pedido: o.order_reference ?? o.shopify_order_id ?? "",
          referencia: o.display_reference ?? "",
          esOutbound: o.is_outbound,
        })),
      })),
    };

    return { ok: true, data } as const;
  });
}
