"use client";
import { useState } from "react";
import type { MiDiaCard, MiDiaMotivo } from "@/lib/services/mi-dia";
import type { SnoozeOption } from "./mi-dia-screen";
import { IconBolt, IconClock } from "./mi-dia-icons";

interface Props {
  card: MiDiaCard;
  danger?: boolean;
  subdued?: boolean;
  exiting: Set<string>;
  onComplete: (m: MiDiaMotivo) => void;
  onSnooze: (m: MiDiaMotivo, o: SnoozeOption) => void;
  onView: (oppId: string) => void;
  onCreateTask: (oppId: string, title: string) => void;
}

// Procedencia de la TAREA: regla (automática) vs manual. El color es sólo
// un acento sutil — el texto de la tarea explica el porqué.
const SOURCE_META: Record<string, { dot: string; label: string }> = {
  rule: { dot: "bg-indigo-500", label: "Generada por una regla" },
  manual: { dot: "bg-slate-400", label: "Tarea manual" },
  system: { dot: "bg-amber-500", label: "Del sistema" },
};

/**
 * Card de Mi Día (rediseño M1v2 correctivo). La OPORTUNIDAD es la unidad.
 * Jerarquía y profundidad:
 *   - barra de acento a la izquierda (rose si atrasada, indigo si normal)
 *   - sombra que se eleva al hover, ring sutil
 *   - el monto en juego se lee grande a la derecha
 * El color sólo grita (rose) cuando hay atraso REAL.
 */
export function MiDiaCardItem({
  card,
  danger,
  subdued,
  exiting,
  onComplete,
  onSnooze,
  onView,
  onCreateTask,
}: Props) {
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");

  return (
    <div
      className={[
        "group relative overflow-hidden rounded-2xl border bg-white pl-4 pr-4 py-4 shadow-sm transition-all dark:bg-slate-800",
        "before:absolute before:inset-y-0 before:left-0 before:w-1.5",
        danger
          ? "border-rose-200 ring-1 ring-rose-100 hover:shadow-md hover:shadow-rose-100/60 before:bg-gradient-to-b before:from-rose-400 before:to-rose-500 dark:border-rose-900/50 dark:ring-rose-900/30"
          : "border-slate-200 hover:border-indigo-200 hover:shadow-md before:bg-gradient-to-b before:from-indigo-300 before:to-indigo-400 dark:border-slate-700 dark:hover:border-indigo-800 dark:before:from-indigo-600 dark:before:to-indigo-700",
        subdued ? "opacity-75 hover:opacity-100" : "",
      ].join(" ")}
    >
      {/* Cabecera: la OPORTUNIDAD es la unidad */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-semibold text-slate-900 dark:text-slate-100">
              {card.available ? card.contactName ?? "Sin nombre" : "Oportunidad no disponible"}
            </span>
            {card.displayReference && (
              <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-500 dark:bg-slate-700/70 dark:text-slate-400">
                {card.displayReference}
              </span>
            )}
            {card.cancelled && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                Cancelada
              </span>
            )}
          </div>
          {card.available && card.stageName && (
            <div className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-slate-50 px-2 py-0.5 dark:bg-slate-900/50">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: card.stageColor ?? "#94A3B8" }}
              />
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
                {card.stageName}
              </span>
            </div>
          )}
        </div>
        {card.amountLabel && (
          <div className="shrink-0 text-right">
            <span className="block text-base font-bold tabular-nums text-slate-900 dark:text-slate-100">
              {card.amountLabel}
            </span>
            <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
              en juego
            </span>
          </div>
        )}
      </div>

      {/* Motivos (tareas) por los que reclama atención */}
      <div className="mt-3 space-y-2">
        {card.motivos.map((m) => (
          <MotivoRow
            key={m.id}
            motivo={m}
            exiting={exiting.has(m.id)}
            onComplete={() => onComplete(m)}
            onSnooze={(o) => onSnooze(m, o)}
          />
        ))}
      </div>

      {/* Pie: ver + nueva tarea */}
      <div className="mt-3 flex items-center gap-3 border-t border-slate-100 pt-2.5 dark:border-slate-700/60">
        {card.available && (
          <button
            onClick={() => onView(card.opportunityId)}
            className="text-xs font-semibold text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
          >
            Ver oportunidad →
          </button>
        )}
        {card.available && !adding && (
          <button
            onClick={() => setAdding(true)}
            className="text-xs font-medium text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
          >
            + tarea
          </button>
        )}
        {adding && (
          <div className="flex flex-1 items-center gap-2">
            <input
              autoFocus
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newTitle.trim()) {
                  onCreateTask(card.opportunityId, newTitle.trim());
                  setNewTitle("");
                  setAdding(false);
                }
                if (e.key === "Escape") setAdding(false);
              }}
              placeholder="Nueva tarea…"
              className="flex-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-slate-600 dark:bg-slate-900 dark:focus:ring-indigo-900/40"
            />
            <button
              onClick={() => {
                if (newTitle.trim()) {
                  onCreateTask(card.opportunityId, newTitle.trim());
                  setNewTitle("");
                }
                setAdding(false);
              }}
              className="rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
            >
              Añadir
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function MotivoRow({
  motivo,
  exiting,
  onComplete,
  onSnooze,
}: {
  motivo: MiDiaMotivo;
  exiting: boolean;
  onComplete: () => void;
  onSnooze: (o: SnoozeOption) => void;
}) {
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const meta = SOURCE_META[motivo.source] ?? SOURCE_META.manual;
  const isOverdue = motivo.urgency === "overdue";

  return (
    <div
      className={[
        "flex items-center gap-2.5 overflow-hidden rounded-xl px-3 py-2 transition-all duration-300",
        isOverdue
          ? "bg-rose-50 dark:bg-rose-950/30"
          : "bg-slate-50 dark:bg-slate-900/40",
        exiting ? "max-h-0 scale-95 py-0 opacity-0" : "max-h-24 opacity-100",
      ].join(" ")}
    >
      <button
        onClick={onComplete}
        aria-label="Completar tarea"
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-slate-300 text-transparent transition-all hover:scale-110 hover:border-emerald-500 hover:bg-emerald-500 hover:text-white dark:border-slate-600"
      >
        <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </button>
      <span className={`h-2 w-2 shrink-0 rounded-full ${meta.dot}`} title={meta.label} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-200">
          {motivo.title}
        </p>
        {isOverdue && (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-600 dark:text-rose-400">
            <IconBolt className="h-3 w-3" />
            Atrasada
          </span>
        )}
      </div>
      <div className="relative shrink-0">
        <button
          onClick={() => setSnoozeOpen((o) => !o)}
          className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-slate-400 hover:bg-slate-200 hover:text-slate-600 dark:hover:bg-slate-700"
          aria-label="Posponer"
        >
          <IconClock className="h-3.5 w-3.5" />
          Posponer
        </button>
        {snoozeOpen && (
          <div
            className="absolute right-0 top-full z-10 mt-1 w-28 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg ring-1 ring-black/5 dark:border-slate-700 dark:bg-slate-800"
            onMouseLeave={() => setSnoozeOpen(false)}
          >
            {([
              ["1h", "1 hora"],
              ["3h", "3 horas"],
              ["tomorrow", "Mañana"],
            ] as Array<[SnoozeOption, string]>).map(([opt, label]) => (
              <button
                key={opt}
                onClick={() => {
                  setSnoozeOpen(false);
                  onSnooze(opt);
                }}
                className="block w-full px-3 py-1.5 text-left text-xs text-slate-600 hover:bg-indigo-50 hover:text-indigo-700 dark:text-slate-300 dark:hover:bg-slate-700"
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
