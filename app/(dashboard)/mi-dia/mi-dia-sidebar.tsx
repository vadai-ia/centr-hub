"use client";
import type { MiDiaSilentClient, MiDiaWeekDay } from "@/lib/services/mi-dia";

const DAY_INITIAL = ["D", "L", "M", "M", "J", "V", "S"];

export function MiDiaSidebar({
  silentClients,
  week,
  streak,
  onView,
}: {
  silentClients: MiDiaSilentClient[];
  week: MiDiaWeekDay[];
  streak: number;
  onView: (contactId: string) => void;
}) {
  return (
    <div className="space-y-4">
      <Widget title="Clientes silenciosos">
        {silentClients.length === 0 ? (
          <p className="text-xs text-slate-400">Nadie en silencio. Todos al día.</p>
        ) : (
          <ul className="space-y-2">
            {silentClients.map((c) => (
              <li key={c.contactId} className="flex items-center justify-between gap-2">
                <button
                  onClick={() => onView(c.contactId)}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block truncate text-sm text-slate-700 hover:text-indigo-600 dark:text-slate-200">
                    {c.name ?? "Sin nombre"}
                  </span>
                  <span className="text-xs text-slate-400">
                    {c.amountLabel ? `${c.amountLabel} · ` : ""}
                    {c.daysSince === null ? "sin actividad" : `${c.daysSince} días`}
                  </span>
                </button>
                <button
                  onClick={() => onView(c.contactId)}
                  className="shrink-0 rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:border-indigo-300 hover:text-indigo-600 dark:border-slate-600 dark:text-slate-300"
                >
                  Empujar
                </button>
              </li>
            ))}
          </ul>
        )}
      </Widget>

      <Widget title="Tu semana">
        <WeekHistogram week={week} />
      </Widget>

      <Widget title="Meta del mes">
        <div className="flex items-center justify-center rounded-lg bg-slate-50 py-4 text-center text-xs text-slate-400 dark:bg-slate-900/40">
          Disponible pronto
        </div>
      </Widget>

      <Widget title="Racha">
        <div className="flex items-center gap-2">
          <span className="text-2xl">{streak > 0 ? "🔥" : "💤"}</span>
          <div>
            <p className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              {streak} {streak === 1 ? "día" : "días"}
            </p>
            <p className="text-xs text-slate-400">
              {streak > 0 ? "completando pendientes" : "Completá una tarea para arrancar"}
            </p>
          </div>
        </div>
      </Widget>
    </div>
  );
}

function Widget({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
        {title}
      </h3>
      {children}
    </section>
  );
}

function WeekHistogram({ week }: { week: MiDiaWeekDay[] }) {
  const max = Math.max(1, ...week.map((d) => Math.max(d.created, d.completed)));
  return (
    <div>
      <div className="flex items-end justify-between gap-1.5" style={{ height: 64 }}>
        {week.map((d) => {
          const di = new Date(`${d.dayKey}T12:00:00Z`).getUTCDay();
          return (
            <div key={d.dayKey} className="flex flex-1 flex-col items-center justify-end gap-0.5">
              <div className="flex h-full w-full items-end justify-center gap-0.5">
                <div
                  className="w-1.5 rounded-t bg-slate-300 dark:bg-slate-600"
                  style={{ height: `${(d.created / max) * 100}%` }}
                  title={`${d.created} creadas`}
                />
                <div
                  className="w-1.5 rounded-t bg-emerald-400"
                  style={{ height: `${(d.completed / max) * 100}%` }}
                  title={`${d.completed} completadas`}
                />
              </div>
              <span className="text-[10px] text-slate-400">{DAY_INITIAL[di]}</span>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex items-center gap-3 text-[10px] text-slate-400">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-emerald-400" /> Completadas
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-slate-300 dark:bg-slate-600" /> Creadas
        </span>
      </div>
    </div>
  );
}
