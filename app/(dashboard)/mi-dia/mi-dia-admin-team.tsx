"use client";
import { useCallback, useState, useTransition } from "react";
import type { MiDiaTeamMember } from "@/lib/services/mi-dia-admin";
import type { MiDiaData, MiDiaMotivo } from "@/lib/services/mi-dia";
import { loadMiDiaMemberAction } from "@/lib/actions/mi-dia-admin";
import { snoozeTaskAction, snoozeNotificationAction, completeNotificationAction } from "@/lib/actions/mi-dia";
import { toggleTaskCompletedAction } from "@/lib/actions/opportunities-m6";
import { MiDiaCardItem } from "./mi-dia-card";
import type { SnoozeOption } from "./mi-dia-screen";

/**
 * Vista equipo del admin (Bloque C): cada vendedor con su conteo de
 * pendientes; click → drilldown con las oportunidades que requieren su
 * atención. El admin puede completar/posponer desde aquí (las acciones
 * ya permiten al admin operar sobre tareas de otros).
 */
export function MiDiaAdminTeam({
  team,
  onView,
}: {
  team: MiDiaTeamMember[];
  onView: (oppId: string) => void;
}) {
  const [selected, setSelected] = useState<MiDiaTeamMember | null>(null);
  const [memberData, setMemberData] = useState<MiDiaData | null>(null);
  const [exiting, setExiting] = useState<Set<string>>(new Set());
  const [, startTransition] = useTransition();

  const loadMember = useCallback((m: MiDiaTeamMember) => {
    setSelected(m);
    setMemberData(null);
    setExiting(new Set());
    startTransition(async () => {
      const res = await loadMiDiaMemberAction({ membershipId: m.membershipId });
      if (res.ok) setMemberData(res.data);
    });
  }, []);

  const reload = useCallback(() => {
    if (!selected) return;
    startTransition(async () => {
      const res = await loadMiDiaMemberAction({ membershipId: selected.membershipId });
      if (res.ok) {
        setMemberData(res.data);
        setExiting(new Set());
      }
    });
  }, [selected]);

  const onComplete = useCallback(
    (m: MiDiaMotivo) => {
      setExiting((p) => new Set(p).add(m.id));
      startTransition(async () => {
        await (m.kind === "task"
          ? toggleTaskCompletedAction({ taskId: m.id })
          : completeNotificationAction({ id: m.id }));
        setTimeout(reload, 280);
      });
    },
    [reload],
  );

  const onSnooze = useCallback(
    (m: MiDiaMotivo, option: SnoozeOption) => {
      setExiting((p) => new Set(p).add(m.id));
      startTransition(async () => {
        await (m.kind === "task"
          ? snoozeTaskAction({ id: m.id, option })
          : snoozeNotificationAction({ id: m.id, option }));
        setTimeout(reload, 280);
      });
    },
    [reload],
  );

  if (selected) {
    const cards = memberData
      ? [
          ...memberData.groups.overdue,
          ...memberData.groups.today,
          ...memberData.groups.week,
        ]
      : [];
    return (
      <div>
        <button
          onClick={() => {
            setSelected(null);
            setMemberData(null);
          }}
          className="mb-3 text-sm text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
        >
          ‹ Volver al equipo
        </button>
        <div className="mb-3 flex items-center gap-2">
          <span
            className="inline-block h-3 w-3 rounded-full"
            style={{ backgroundColor: selected.color }}
          />
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            {selected.name ?? "Vendedor"}
          </h2>
        </div>
        {!memberData ? (
          <p className="text-sm text-slate-400">Cargando…</p>
        ) : cards.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-200 py-10 text-center text-sm text-slate-400 dark:border-slate-700">
            Sin pendientes. Al día.
          </p>
        ) : (
          <div className="space-y-2.5">
            {cards.map((card) => (
              <MiDiaCardItem
                key={card.opportunityId}
                card={card}
                danger={card.urgency === "overdue"}
                exiting={exiting}
                onComplete={onComplete}
                onSnooze={onSnooze}
                onView={onView}
                onCreateTask={() => {}}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {team.length === 0 && (
        <p className="text-sm text-slate-400">No hay vendedores activos.</p>
      )}
      {team.map((m) => (
        <button
          key={m.membershipId}
          onClick={() => loadMember(m)}
          className="flex w-full items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left hover:border-indigo-300 dark:border-slate-700 dark:bg-slate-800"
        >
          <div className="flex items-center gap-2">
            <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: m.color }} />
            <span className="font-medium text-slate-900 dark:text-slate-100">
              {m.name ?? "Vendedor"}
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            {m.overdue > 0 && (
              <span className="rounded-full bg-rose-100 px-2 py-0.5 font-medium text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">
                {m.overdue} atrasadas
              </span>
            )}
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600 dark:bg-slate-700 dark:text-slate-300">
              {m.today} hoy
            </span>
            {m.pipelineAtStakeLabel && (
              <span className="hidden text-slate-400 sm:inline">{m.pipelineAtStakeLabel}</span>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}
