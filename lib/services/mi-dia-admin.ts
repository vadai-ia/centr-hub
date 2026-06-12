import "server-only";
import { getCurrentOrganizationId } from "@/lib/tenant/context";
import { listActiveRealVendors } from "@/lib/db/users";
import { listUnassignedActiveOpportunityCards } from "@/lib/db/opportunities";
import { listPipelineStages } from "@/lib/db/pipeline";
import { loadMiDiaForUser } from "@/lib/services/mi-dia";
import { effectiveAmount, formatAmountCompact } from "@/lib/format/money";
import type { Funnel, UUID } from "@/lib/types/database";

/**
 * Mi Día del admin (M1v2, Bloque C). Dos piezas extra sobre la vista de
 * vendedor: resumen por persona del equipo (para el toggle "Vista
 * equipo" + drilldown) y las oportunidades sin asignar (para tomarlas o
 * asignarlas desde Mi Día). DEBE invocarse dentro de `withTenantContext`.
 */

export interface MiDiaTeamMember {
  membershipId: UUID;
  userId: UUID;
  name: string | null;
  color: string;
  overdue: number;
  today: number;
  pipelineAtStakeLabel: string | null;
}

export interface MiDiaUnassignedCard {
  opportunityId: UUID;
  funnel: Funnel;
  displayReference: string | null;
  contactName: string | null;
  amountLabel: string | null;
  amountValue: number;
  stageName: string | null;
  stageColor: string | null;
}

export interface MiDiaAdminExtras {
  team: MiDiaTeamMember[];
  unassigned: MiDiaUnassignedCard[];
  vendors: Array<{ membershipId: UUID; name: string | null }>;
}

export async function loadMiDiaAdminExtras(): Promise<MiDiaAdminExtras> {
  const orgId = getCurrentOrganizationId();
  const vendors = await listActiveRealVendors(orgId);

  // Resumen por vendedor — reusa la agregación de Mi Día y toma sus
  // indicadores. Equipos chicos (MVP): N llamadas es aceptable.
  const team: MiDiaTeamMember[] = [];
  for (const v of vendors) {
    const data = await loadMiDiaForUser({
      userId: v.user_id,
      advisorMembershipId: v.id,
    });
    team.push({
      membershipId: v.id,
      userId: v.user_id,
      name: v.profile.full_name,
      color: v.profile.color,
      overdue: data.indicators.overdue,
      today: data.indicators.today,
      pipelineAtStakeLabel: data.indicators.pipelineAtStakeLabel,
    });
  }
  // Más urgentes primero (más atrasadas, luego más de hoy).
  team.sort((a, b) => b.overdue - a.overdue || b.today - a.today);

  const unassigned = await loadUnassignedCards();

  return {
    team,
    unassigned,
    vendors: vendors.map((v) => ({ membershipId: v.id, name: v.profile.full_name })),
  };
}

async function loadUnassignedCards(): Promise<MiDiaUnassignedCard[]> {
  const [opps, stages] = await Promise.all([
    listUnassignedActiveOpportunityCards(),
    listPipelineStages(),
  ]);
  const stageMap = new Map(stages.map((s) => [s.id, s]));
  const cards = opps.map((o) => {
    const amt = effectiveAmount(o);
    const num = amt.value ? Number(amt.value) : 0;
    return {
      opportunityId: o.id,
      funnel: o.funnel,
      displayReference: o.display_reference,
      contactName: o.contact?.full_name ?? null,
      amountLabel: formatAmountCompact(amt.value, o.currency),
      amountValue: Number.isFinite(num) ? num : 0,
      stageName: stageMap.get(o.stage_id)?.name ?? null,
      stageColor: stageMap.get(o.stage_id)?.color ?? null,
    };
  });
  cards.sort((a, b) => b.amountValue - a.amountValue);
  return cards;
}
