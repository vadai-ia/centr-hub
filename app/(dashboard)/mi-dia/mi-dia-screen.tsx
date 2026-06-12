"use client";
import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { MiDiaData, MiDiaMotivo } from "@/lib/services/mi-dia";
import { loadMiDiaAction, snoozeTaskAction, snoozeNotificationAction, completeNotificationAction } from "@/lib/actions/mi-dia";
import { toggleTaskCompletedAction, createTaskForOpportunityAction } from "@/lib/actions/opportunities-m6";
import { MiDiaHeader } from "./mi-dia-header";
import { MiDiaCardItem } from "./mi-dia-card";
import { MiDiaBell } from "./mi-dia-bell";
import { MiDiaSidebar } from "./mi-dia-sidebar";
import { useMiDiaRealtime } from "./use-mi-dia-realtime";
import { MiDiaUnassigned } from "./mi-dia-unassigned";
import { MiDiaAdminTeam } from "./mi-dia-admin-team";
import { loadMiDiaAdminExtrasAction } from "@/lib/actions/mi-dia-admin";
import type { MiDiaAdminExtras } from "@/lib/services/mi-dia-admin";

interface Props {
  initialData: MiDiaData;
  organizationId: string;
  userId: string;
  isAdmin: boolean;
  initialAdminExtras: MiDiaAdminExtras | null;
}

export type SnoozeOption = "1h" | "3h" | "tomorrow";

const REST_PAGE = 5;

export function MiDiaScreen({
  initialData,
  organizationId,
  userId,
  isAdmin,
  initialAdminExtras,
}: Props) {
  const router = useRouter();
  const [data, setData] = useState(initialData);
  const [extras, setExtras] = useState<MiDiaAdminExtras | null>(initialAdminExtras);
  const [view, setView] = useState<"mine" | "team">("mine");
  const [exiting, setExiting] = useState<Set<string>>(new Set());
  const [restOpen, setRestOpen] = useState(false);
  const [restVisible, setRestVisible] = useState(REST_PAGE);
  const [bellOpen, setBellOpen] = useState(false);
  const [, startTransition] = useTransition();

  const refresh = useCallback(() => {
    startTransition(async () => {
      const res = await loadMiDiaAction();
      if (res.ok) {
        setData(res.data);
        setExiting(new Set());
      }
      if (isAdmin) {
        const ex = await loadMiDiaAdminExtrasAction();
        if (ex.ok) setExtras(ex.extras);
      }
    });
  }, [isAdmin]);

  const rtStatus = useMiDiaRealtime({ organizationId, userId, onChange: refresh });

  // Microrrecompensa: marca el motivo como saliente (transición CSS), y
  // tras la animación recarga. Al recargar, la sección prioritaria se
  // re-corta a 3: la card que se vació sale y sube la siguiente de la
  // reserva, manteniendo siempre 3 visibles.
  const animateOut = useCallback(
    (motivoId: string, run: () => Promise<unknown>) => {
      setExiting((prev) => new Set(prev).add(motivoId));
      startTransition(async () => {
        await run();
        setTimeout(refresh, 280);
      });
    },
    [refresh],
  );

  const onComplete = useCallback(
    (m: MiDiaMotivo) => {
      animateOut(m.id, () =>
        m.kind === "task"
          ? toggleTaskCompletedAction({ taskId: m.id })
          : completeNotificationAction({ id: m.id }),
      );
    },
    [animateOut],
  );

  const onSnooze = useCallback(
    (m: MiDiaMotivo, option: SnoozeOption) => {
      animateOut(m.id, () =>
        m.kind === "task"
          ? snoozeTaskAction({ id: m.id, option })
          : snoozeNotificationAction({ id: m.id, option }),
      );
    },
    [animateOut],
  );

  const onView = useCallback(
    (oppId: string) => router.push(`/pipeline?opp=${oppId}`),
    [router],
  );

  const onCreateTask = useCallback(
    (oppId: string, title: string) => {
      startTransition(async () => {
        await createTaskForOpportunityAction({
          opportunityId: oppId,
          taskType: "follow_up",
          title,
          description: "",
          dueAt: "",
        });
        refresh();
      });
    },
    [refresh],
  );

  // Orden de prioridad único: atrasadas → hoy → esta semana; dentro de
  // cada urgencia, mayor monto primero (los grupos ya vienen ordenados
  // por monto desc desde el servicio, así que concatenar preserva el
  // criterio). El top 3 enfoca; el resto se subordina.
  const prioritized = [
    ...data.groups.overdue,
    ...data.groups.today,
    ...data.groups.week,
  ];
  const top = prioritized.slice(0, 3);
  const rest = prioritized.slice(3);
  const overdueTotal = data.groups.overdue.length;
  const restShown = Math.min(restVisible, rest.length);

  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Mi Día</h1>
            {rtStatus === "offline" && (
              <span
                title="Sin conexión en vivo — actualizando cada 30 s"
                className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500 dark:bg-slate-700 dark:text-slate-400"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                Sin conexión en vivo
              </span>
            )}
          </div>
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
            Lo que necesita tu atención hoy, una oportunidad a la vez.
          </p>
        </div>
        <MiDiaBell
          items={data.bell}
          open={bellOpen}
          onToggle={() => setBellOpen((o) => !o)}
          onClose={() => setBellOpen(false)}
          onView={onView}
          onAfterAction={refresh}
        />
      </div>

      <MiDiaHeader indicators={data.indicators} />

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <main className="min-w-0 space-y-4">
          {isAdmin && (
            <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 text-sm dark:border-slate-700 dark:bg-slate-800">
              <button onClick={() => setView("mine")} className={tabCls(view === "mine")}>
                Mis pendientes
              </button>
              <button onClick={() => setView("team")} className={tabCls(view === "team")}>
                Vista equipo
              </button>
            </div>
          )}

          {isAdmin && view === "team" ? (
            <MiDiaAdminTeam team={extras?.team ?? []} onView={onView} />
          ) : prioritized.length === 0 && (!isAdmin || !extras?.unassigned.length) ? (
            <EmptyState />
          ) : (
            <div className="space-y-6">
              {prioritized.length > 0 && (
                <>
              {/* Sección prioritaria — solo 3 cards */}
              <section>
                <h2 className="mb-3 flex items-center gap-2">
                  <span className="text-sm font-semibold uppercase tracking-wide text-slate-700 dark:text-slate-300">
                    Requieren tu atención
                  </span>
                  {overdueTotal > 0 && (
                    <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">
                      {overdueTotal} atrasada{overdueTotal === 1 ? "" : "s"}
                    </span>
                  )}
                </h2>
                <div className="space-y-2.5">
                  {top.map((card) => (
                    <MiDiaCardItem
                      key={card.opportunityId}
                      card={card}
                      danger={card.urgency === "overdue"}
                      exiting={exiting}
                      onComplete={onComplete}
                      onSnooze={onSnooze}
                      onView={onView}
                      onCreateTask={onCreateTask}
                    />
                  ))}
                </div>
              </section>

              {/* El resto — desplegable, de a 5 */}
              {rest.length > 0 && (
                <div>
                  <button
                    onClick={() => setRestOpen((o) => !o)}
                    className="flex w-full items-center gap-2 text-left text-sm font-medium text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                  >
                    <span className={`transition-transform ${restOpen ? "rotate-90" : ""}`}>›</span>
                    El resto
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500 dark:bg-slate-700 dark:text-slate-400">
                      {rest.length}
                    </span>
                  </button>
                  {restOpen && (
                    <div className="mt-3 space-y-2">
                      {rest.slice(0, restShown).map((card) => (
                        <MiDiaCardItem
                          key={card.opportunityId}
                          card={card}
                          subdued
                          exiting={exiting}
                          onComplete={onComplete}
                          onSnooze={onSnooze}
                          onView={onView}
                          onCreateTask={onCreateTask}
                        />
                      ))}
                      {restShown < rest.length && (
                        <button
                          onClick={() => setRestVisible((v) => v + REST_PAGE)}
                          className="mt-1 w-full rounded-lg border border-dashed border-slate-200 py-2 text-sm text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                        >
                          Ver más ({rest.length - restShown})
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
                </>
              )}
              {isAdmin && extras && (
                <MiDiaUnassigned
                  cards={extras.unassigned}
                  vendors={extras.vendors}
                  onView={onView}
                  onAssigned={refresh}
                />
              )}
            </div>
          )}
        </main>

        <aside className="min-w-0">
          <MiDiaSidebar
            silentClients={data.silentClients}
            week={data.week}
            streak={data.streak}
            onView={(contactId) => router.push(`/contactos/${contactId}`)}
          />
        </aside>
      </div>
    </div>
  );
}

function tabCls(active: boolean): string {
  return [
    "rounded-md px-3 py-1.5 font-medium transition-colors",
    active
      ? "bg-indigo-600 text-white"
      : "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100",
  ].join(" ");
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white py-16 text-center dark:border-slate-700 dark:bg-slate-800">
      <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-2xl dark:bg-emerald-900/40">
        ✓
      </div>
      <p className="text-lg font-medium text-slate-800 dark:text-slate-100">
        Sin pendientes ahora. Buen trabajo.
      </p>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        Cuando una regla o un seguimiento requieran tu atención, aparecerán aquí.
      </p>
    </div>
  );
}
