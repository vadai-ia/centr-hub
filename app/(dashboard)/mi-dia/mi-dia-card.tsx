"use client";
import { useState } from "react";
import type { MiDiaCard, MiDiaMotivo } from "@/lib/services/mi-dia";
import type { SnoozeOption } from "./mi-dia-screen";

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

const SOURCE_META: Record<string, { dot: string; label: string }> = {
  rule: { dot: "bg-indigo-500", label: "Regla" },
  manual: { dot: "bg-slate-400", label: "Tarea" },
  system: { dot: "bg-amber-500", label: "Sistema" },
};

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
        "rounded-xl border bg-white p-4 transition-shadow dark:bg-slate-800",
        danger
          ? "border-rose-200 dark:border-rose-900/50"
          : "border-slate-200 dark:border-slate-700",
        subdued ? "opacity-80" : "",
      ].join(" ")}
    >
      {/* Cabecera: la OPORTUNIDAD es la unidad */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium text-slate-900 dark:text-slate-100">
              {card.available ? card.contactName ?? "Sin nombre" : "Oportunidad no disponible"}
            </span>
            {card.displayReference && (
              <span className="text-xs text-slate-400">{card.displayReference}</span>
            )}
            {card.cancelled && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                Cancelada
              </span>
            )}
          </div>
          {card.available && card.stageName && (
            <div className="mt-1 flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: card.stageColor ?? "#94A3B8" }}
              />
              <span className="text-xs text-slate-500 dark:text-slate-400">{card.stageName}</span>
            </div>
          )}
        </div>
        {card.amountLabel && (
          <div className="shrink-0 text-right">
            <span className="text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100">
              {card.amountLabel}
            </span>
          </div>
        )}
      </div>

      {/* Motivos por los que reclama atención */}
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
            className="text-xs font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
          >
            Ver oportunidad
          </button>
        )}
        {card.available && !adding && (
          <button
            onClick={() => setAdding(true)}
            className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
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
              className="flex-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-600 dark:bg-slate-900"
            />
            <button
              onClick={() => {
                if (newTitle.trim()) {
                  onCreateTask(card.opportunityId, newTitle.trim());
                  setNewTitle("");
                }
                setAdding(false);
              }}
              className="text-xs font-medium text-indigo-600"
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

  return (
    <div
      className={[
        "flex items-center gap-2 overflow-hidden rounded-lg bg-slate-50 px-2.5 py-2 transition-all duration-300 dark:bg-slate-900/40",
        exiting ? "max-h-0 scale-95 py-0 opacity-0" : "max-h-24 opacity-100",
      ].join(" ")}
    >
      <button
        onClick={onComplete}
        aria-label="Completar"
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-slate-300 text-transparent transition-colors hover:border-emerald-500 hover:bg-emerald-500 hover:text-white dark:border-slate-600"
      >
        ✓
      </button>
      <span className={`h-2 w-2 shrink-0 rounded-full ${meta.dot}`} title={meta.label} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-slate-800 dark:text-slate-200">{motivo.title}</p>
        {motivo.urgency === "overdue" && (
          <span className="text-[11px] font-medium text-rose-600 dark:text-rose-400">Atrasada</span>
        )}
      </div>
      <div className="relative shrink-0">
        <button
          onClick={() => setSnoozeOpen((o) => !o)}
          className="rounded px-1.5 py-1 text-xs text-slate-400 hover:bg-slate-200 hover:text-slate-600 dark:hover:bg-slate-700"
          aria-label="Posponer"
        >
          Posponer
        </button>
        {snoozeOpen && (
          <div
            className="absolute right-0 top-full z-10 mt-1 w-28 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-800"
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
                className="block w-full px-3 py-1.5 text-left text-xs text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700"
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
