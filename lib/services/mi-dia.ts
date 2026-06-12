import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import { listTasksForUser, listNotificationsForUser } from "@/lib/db/operational";
import {
  listOpportunities,
  listKanbanOpportunitiesByIds,
} from "@/lib/db/opportunities";
import { listPipelineStages } from "@/lib/db/pipeline";
import { lastPlatformActivityForContacts } from "@/lib/services/activity-aggregation";
import { effectiveAmount, formatAmountCompact } from "@/lib/format/money";
import {
  todayBoundsUtc,
  endOfWeekWindowUtc,
  dayKeyInTz,
  todayKeyInTz,
  lastNDayKeys,
} from "@/lib/time/period";
import type {
  NotificationOrigin,
  NotificationRow,
  TaskRow,
  UUID,
} from "@/lib/types/database";

/**
 * Mi Día — capa de datos (M1v2, Bloque B). El CENTRO es la oportunidad:
 * agrupamos las tareas y los avisos del usuario por oportunidad, las
 * clasificamos por urgencia (Atrasadas / Hoy / Esta semana) y las
 * ordenamos por monto. Reutiliza el MISMO modelo de tareas de V1, así que
 * completar aquí se refleja en el detalle/pipeline y viceversa.
 *
 * DEBE invocarse dentro de `withTenantContext`.
 */

export type Urgency = "overdue" | "today" | "week";

export interface MiDiaMotivo {
  kind: "task" | "notification";
  id: UUID;
  title: string;
  source: NotificationOrigin; // manual | rule | system
  taskType: string | null;
  notificationType: string | null;
  message: string | null;
  dueAt: string | null;
  urgency: Urgency;
}

export interface MiDiaCard {
  opportunityId: UUID;
  available: boolean;
  displayReference: string | null;
  contactName: string | null;
  amountLabel: string | null;
  amountValue: number;
  currency: string;
  stageName: string | null;
  stageColor: string | null;
  cancelled: boolean;
  urgency: Urgency;
  motivos: MiDiaMotivo[];
}

export interface MiDiaBellItem {
  id: UUID;
  title: string;
  message: string;
  notificationType: string;
  origin: NotificationOrigin;
  isAlert: boolean;
  createdAt: string;
  opportunityId: UUID | null;
  contactId: UUID | null;
  status: string;
}

export interface MiDiaSilentClient {
  contactId: UUID;
  name: string | null;
  amountLabel: string | null;
  lastActivityAt: string | null;
  daysSince: number | null;
}

export interface MiDiaWeekDay {
  dayKey: string;
  created: number;
  completed: number;
}

export interface MiDiaData {
  indicators: {
    overdue: number;
    today: number;
    pipelineAtStakeLabel: string | null;
    completedToday: number;
  };
  groups: { overdue: MiDiaCard[]; today: MiDiaCard[]; week: MiDiaCard[] };
  bell: MiDiaBellItem[];
  silentClients: MiDiaSilentClient[];
  week: MiDiaWeekDay[];
  streak: number;
}

const URGENCY_RANK: Record<Urgency, number> = { overdue: 0, today: 1, week: 2 };
const SILENT_DAYS_THRESHOLD = 5;

function bucket(dueAt: string | null, startUtc: string, endUtc: string): Urgency {
  if (!dueAt) return "today";
  if (dueAt < startUtc) return "overdue";
  if (dueAt <= endUtc) return "today";
  return "week";
}

export async function loadMiDiaForUser(input: {
  userId: UUID;
  advisorMembershipId: UUID | null;
}): Promise<MiDiaData> {
  const { startUtc, endUtc } = todayBoundsUtc();
  const weekEndUtc = endOfWeekWindowUtc();
  const todayKey = todayKeyInTz();

  const [tasks, notifications, stages] = await Promise.all([
    listTasksForUser(input.userId),
    listNotificationsForUser(input.userId),
    listPipelineStages(),
  ]);
  const stageMap = new Map(stages.map((s) => [s.id, s]));

  // --- Motivos abiertos (pending) agrupados por oportunidad ---
  const pendingTasks = tasks.filter((t) => t.status === "pending");
  const pendingNotifs = notifications.filter((n) => n.status === "pending");

  const oppIds = new Set<UUID>();
  for (const t of pendingTasks) if (t.opportunity_id) oppIds.add(t.opportunity_id);
  for (const n of pendingNotifs) if (n.opportunity_id) oppIds.add(n.opportunity_id);

  const cardsData = await listKanbanOpportunitiesByIds(Array.from(oppIds));
  const oppById = new Map(cardsData.map((o) => [o.id, o]));

  const cardMap = new Map<UUID, MiDiaCard>();
  function ensureCard(oppId: UUID): MiDiaCard {
    let card = cardMap.get(oppId);
    if (card) return card;
    const opp = oppById.get(oppId);
    const amt = opp ? effectiveAmount(opp) : { value: null, isEstimated: false };
    const amtNum = amt.value ? Number(amt.value) : 0;
    card = {
      opportunityId: oppId,
      available: !!opp,
      displayReference: opp?.display_reference ?? null,
      contactName: opp?.contact?.full_name ?? null,
      amountLabel: opp ? formatAmountCompact(amt.value, opp.currency) : null,
      amountValue: Number.isFinite(amtNum) ? amtNum : 0,
      currency: opp?.currency ?? "MXN",
      stageName: opp ? stageMap.get(opp.stage_id)?.name ?? null : null,
      stageColor: opp ? stageMap.get(opp.stage_id)?.color ?? null : null,
      cancelled: !!opp?.cancelled_at,
      urgency: "week",
      motivos: [],
    };
    cardMap.set(oppId, card);
    return card;
  }

  for (const t of pendingTasks) {
    if (!t.opportunity_id) continue; // tareas sin opp no entran al centro
    const card = ensureCard(t.opportunity_id);
    const urgency = bucket(t.due_at, startUtc, endUtc);
    card.motivos.push({
      kind: "task",
      id: t.id,
      title: t.title,
      source: t.created_by_rule_id ? "rule" : "manual",
      taskType: t.task_type,
      notificationType: null,
      message: t.description,
      dueAt: t.due_at,
      urgency,
    });
  }
  for (const n of pendingNotifs) {
    if (!n.opportunity_id) continue; // los sin-opp viven solo en la campanita
    const card = ensureCard(n.opportunity_id);
    const urgency = bucket(n.due_at, startUtc, endUtc);
    card.motivos.push({
      kind: "notification",
      id: n.id,
      title: n.title,
      source: n.origin,
      taskType: null,
      notificationType: n.notification_type,
      message: n.message,
      dueAt: n.due_at,
      urgency,
    });
  }

  // Urgencia de la card = la más alta entre sus motivos.
  const cards: MiDiaCard[] = [];
  for (const card of Array.from(cardMap.values())) {
    if (card.motivos.length === 0) continue;
    let highest: Urgency = "week";
    for (const m of card.motivos) {
      if (URGENCY_RANK[m.urgency] < URGENCY_RANK[highest]) highest = m.urgency;
    }
    card.urgency = highest;
    cards.push(card);
  }

  const groups = { overdue: [] as MiDiaCard[], today: [] as MiDiaCard[], week: [] as MiDiaCard[] };
  for (const c of cards) groups[c.urgency].push(c);
  const byAmountDesc = (a: MiDiaCard, b: MiDiaCard) => b.amountValue - a.amountValue;
  groups.overdue.sort(byAmountDesc);
  groups.today.sort(byAmountDesc);
  groups.week.sort(byAmountDesc);

  // --- Indicadores ---
  const pipelineSum = [...groups.overdue, ...groups.today].reduce(
    (acc, c) => acc + c.amountValue,
    0,
  );
  const completedToday = countCompletedToday(tasks, notifications, startUtc);

  // --- Campanita: todos los avisos pendientes (incl. sin opp) ---
  const bell: MiDiaBellItem[] = pendingNotifs
    .map((n) => ({
      id: n.id,
      title: n.title,
      message: n.message,
      notificationType: n.notification_type,
      origin: n.origin,
      isAlert: n.notification_type === "alert",
      createdAt: n.created_at,
      opportunityId: n.opportunity_id,
      contactId: n.contact_id,
      status: n.status,
    }))
    .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));

  // --- Sidebar widgets ---
  const [silentClients, week] = await Promise.all([
    input.advisorMembershipId
      ? loadSilentClients(input.advisorMembershipId)
      : Promise.resolve([]),
    Promise.resolve(buildWeekHistogram(tasks)),
  ]);
  const streak = computeStreak(tasks, todayKey);

  return {
    indicators: {
      overdue: groups.overdue.length,
      today: groups.today.length,
      pipelineAtStakeLabel: formatAmountCompact(pipelineSum, "MXN"),
      completedToday,
    },
    groups,
    bell,
    silentClients,
    week,
    streak,
  };
}

function countCompletedToday(
  tasks: TaskRow[],
  notifications: NotificationRow[],
  startUtc: string,
): number {
  let n = 0;
  for (const t of tasks) {
    if (t.status === "completed" && t.completed_at && t.completed_at >= startUtc) n += 1;
  }
  for (const x of notifications) {
    if (x.status === "completed" && x.completed_at && x.completed_at >= startUtc) n += 1;
  }
  return n;
}

function buildWeekHistogram(tasks: TaskRow[]): MiDiaWeekDay[] {
  const keys = lastNDayKeys(7);
  const created = new Map<string, number>();
  const completed = new Map<string, number>();
  for (const t of tasks) {
    const ck = dayKeyInTz(t.created_at);
    if (created.has(ck) || keys.includes(ck)) created.set(ck, (created.get(ck) ?? 0) + 1);
    if (t.completed_at) {
      const dk = dayKeyInTz(t.completed_at);
      if (keys.includes(dk)) completed.set(dk, (completed.get(dk) ?? 0) + 1);
    }
  }
  return keys.map((k) => ({
    dayKey: k,
    created: created.get(k) ?? 0,
    completed: completed.get(k) ?? 0,
  }));
}

function computeStreak(tasks: TaskRow[], todayKey: string): number {
  const days = new Set<string>();
  for (const t of tasks) {
    if (t.completed_at) days.add(dayKeyInTz(t.completed_at));
  }
  if (days.size === 0) return 0;
  // Arranca en hoy (si hay) o ayer (gracia: la racha sigue viva si ayer
  // completaste y hoy aún no). Luego cuenta hacia atrás.
  const [y, m, d] = todayKey.split("-").map((x) => parseInt(x, 10));
  let cursor = new Date(Date.UTC(y, m - 1, d));
  const fmt = (date: Date) =>
    `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(
      date.getUTCDate(),
    ).padStart(2, "0")}`;
  if (!days.has(fmt(cursor))) {
    cursor = new Date(cursor.getTime() - 86_400_000);
    if (!days.has(fmt(cursor))) return 0;
  }
  let streak = 0;
  while (days.has(fmt(cursor))) {
    streak += 1;
    cursor = new Date(cursor.getTime() - 86_400_000);
  }
  return streak;
}

async function loadSilentClients(
  advisorMembershipId: UUID,
): Promise<MiDiaSilentClient[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("contacts")
    .select("id, full_name")
    .eq("organization_id", organizationId)
    .eq("assigned_advisor_id", advisorMembershipId)
    .eq("deleted_in_whaapy", false)
    .limit(2000);
  if (error) throw error;
  const contacts = (data ?? []) as Array<{ id: UUID; full_name: string | null }>;
  if (contacts.length === 0) return [];

  // Monto por contacto = mayor monto efectivo entre sus opps activas.
  const opps = await listOpportunities({ assignedAdvisorId: advisorMembershipId });
  const amountByContact = new Map<UUID, number>();
  for (const o of opps) {
    const amt = effectiveAmount(o);
    const num = amt.value ? Number(amt.value) : 0;
    if (!Number.isFinite(num)) continue;
    amountByContact.set(o.contact_id, Math.max(amountByContact.get(o.contact_id) ?? 0, num));
  }

  const activityMap = await lastPlatformActivityForContacts(contacts.map((c) => c.id));
  const nowMs = Date.now();

  const silent: MiDiaSilentClient[] = [];
  for (const c of contacts) {
    const last = activityMap.get(c.id) ?? null;
    const daysSince = last ? Math.floor((nowMs - Date.parse(last)) / 86_400_000) : null;
    // Silencioso: sin actividad nunca registrada, o > umbral de días.
    if (daysSince !== null && daysSince <= SILENT_DAYS_THRESHOLD) continue;
    const amountVal = amountByContact.get(c.id) ?? 0;
    silent.push({
      contactId: c.id,
      name: c.full_name,
      amountLabel: amountVal > 0 ? formatAmountCompact(amountVal, "MXN") : null,
      lastActivityAt: last,
      daysSince,
    });
  }
  // Mayor monto primero; a igualdad, más días en silencio primero.
  silent.sort((a, b) => {
    const amtA = a.amountLabel ? 1 : 0;
    const amtB = b.amountLabel ? 1 : 0;
    if (amtB !== amtA) return amtB - amtA;
    return (b.daysSince ?? Infinity) - (a.daysSince ?? Infinity);
  });
  return silent.slice(0, 3);
}
