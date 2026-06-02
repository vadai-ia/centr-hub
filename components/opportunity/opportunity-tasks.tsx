"use client";
import { useState } from "react";
import {
  deleteTaskAction,
  toggleTaskCompletedAction,
  type OpportunityTaskItem,
} from "@/lib/actions/opportunities-m6";
import { formatRelative } from "@/app/(dashboard)/contactos/utils";
import { EditTaskDialog } from "./edit-task-dialog";

interface Props {
  tasks: OpportunityTaskItem[];
  canCreate: boolean;
  canManage: boolean;
  onCreateClick: () => void;
  onChanged: () => void;
}

const TASK_TYPE_LABELS: Record<string, string> = {
  call: "Llamada",
  message: "Mensaje",
  quote: "Cotización",
  follow_up: "Seguimiento",
  meeting: "Reunión",
  other: "Otra",
};

const TASK_TYPE_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  call: { bg: "bg-blue-100 dark:bg-blue-500/15", text: "text-blue-700 dark:text-blue-300", dot: "bg-blue-500" },
  message: { bg: "bg-sky-100 dark:bg-sky-500/15", text: "text-sky-700 dark:text-sky-300", dot: "bg-sky-500" },
  quote: { bg: "bg-purple-100 dark:bg-purple-500/15", text: "text-purple-700 dark:text-purple-300", dot: "bg-purple-500" },
  follow_up: { bg: "bg-amber-100 dark:bg-amber-500/15", text: "text-amber-700 dark:text-amber-300", dot: "bg-amber-500" },
  meeting: { bg: "bg-emerald-100 dark:bg-emerald-500/15", text: "text-emerald-700 dark:text-emerald-300", dot: "bg-emerald-500" },
  other: { bg: "bg-gray-100 dark:bg-gray-700", text: "text-gray-700 dark:text-gray-300", dot: "bg-gray-400" },
};

/**
 * Sección de tareas del popup de oportunidad (lote polish M6).
 *
 * Cada tarea: chip de tipo coloreado, título, descripción, due_at
 * relativo, autor. Acciones inline si canManage: completar/reabrir,
 * editar, eliminar (con confirm).
 */
export function OpportunityTasks({ tasks, canCreate, canManage, onCreateClick, onChanged }: Props) {
  const [editing, setEditing] = useState<OpportunityTaskItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const pending = tasks.filter((t) => t.status !== "completed");
  const completed = tasks.filter((t) => t.status === "completed");

  async function handleToggle(task: OpportunityTaskItem) {
    if (busyId) return;
    setBusyId(task.id);
    const res = await toggleTaskCompletedAction({ taskId: task.id });
    setBusyId(null);
    if (res.ok) onChanged();
  }

  async function handleDelete(task: OpportunityTaskItem) {
    if (busyId) return;
    if (!confirm(`¿Eliminar la tarea "${task.title}"?`)) return;
    setBusyId(task.id);
    const res = await deleteTaskAction({ taskId: task.id });
    setBusyId(null);
    if (res.ok) onChanged();
  }

  return (
    <section className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
      <header className="px-4 py-3 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between gap-3 bg-blue-50/40 dark:bg-blue-500/5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-blue-600 dark:text-blue-400" aria-hidden>
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 11l3 3L22 4"/>
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
            </svg>
          </span>
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
            Tareas
          </h3>
          <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">
            {pending.length} pendiente{pending.length === 1 ? "" : "s"}
            {completed.length > 0 ? ` · ${completed.length} completada${completed.length === 1 ? "" : "s"}` : ""}
          </span>
        </div>
        {canCreate && (
          <button
            type="button"
            onClick={onCreateClick}
            className="text-xs font-medium px-2.5 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-400"
          >
            + Crear tarea
          </button>
        )}
      </header>
      {tasks.length === 0 ? (
        <p className="px-4 py-6 text-sm text-gray-400 dark:text-gray-500 text-center italic">
          Sin tareas registradas para esta oportunidad.
        </p>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-700">
          {pending.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              canManage={canManage}
              busy={busyId === t.id}
              onToggle={() => handleToggle(t)}
              onEdit={() => setEditing(t)}
              onDelete={() => handleDelete(t)}
            />
          ))}
          {completed.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              canManage={canManage}
              busy={busyId === t.id}
              onToggle={() => handleToggle(t)}
              onEdit={() => setEditing(t)}
              onDelete={() => handleDelete(t)}
              isCompleted
            />
          ))}
        </ul>
      )}
      <EditTaskDialog
        open={editing !== null}
        task={editing}
        onCancel={() => setEditing(null)}
        onSuccess={() => {
          setEditing(null);
          onChanged();
        }}
      />
    </section>
  );
}

function TaskRow({
  task,
  canManage,
  busy,
  onToggle,
  onEdit,
  onDelete,
  isCompleted,
}: {
  task: OpportunityTaskItem;
  canManage: boolean;
  busy: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  isCompleted?: boolean;
}) {
  const typeColors = TASK_TYPE_COLORS[task.task_type] ?? TASK_TYPE_COLORS.other;
  const typeLabel = TASK_TYPE_LABELS[task.task_type] ?? task.task_type;
  const dueDate = task.due_at ? new Date(task.due_at) : null;
  const now = new Date();
  const isOverdue = dueDate !== null && !isCompleted && dueDate.getTime() < now.getTime();

  return (
    <li className={[
      "px-4 py-3 flex items-start gap-3",
      isCompleted ? "opacity-60" : "",
    ].join(" ")}>
      {canManage ? (
        <button
          type="button"
          onClick={onToggle}
          disabled={busy}
          className={[
            "mt-0.5 w-5 h-5 rounded-md border-2 flex-shrink-0 flex items-center justify-center transition-colors",
            isCompleted
              ? "border-emerald-600 bg-emerald-600 text-white"
              : "border-gray-300 dark:border-gray-600 hover:border-emerald-500",
            busy ? "opacity-50 cursor-wait" : "",
          ].join(" ")}
          aria-label={isCompleted ? "Reabrir tarea" : "Marcar como completada"}
        >
          {isCompleted && (
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          )}
        </button>
      ) : (
        <span className="mt-0.5 w-5 h-5 rounded-md border-2 border-gray-300 dark:border-gray-600 flex-shrink-0" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-medium ${typeColors.bg} ${typeColors.text}`}>
            {typeLabel}
          </span>
          <span className={[
            "text-sm font-medium",
            isCompleted ? "line-through text-gray-400" : "text-gray-900 dark:text-gray-100",
          ].join(" ")}>
            {task.title}
          </span>
        </div>
        {task.description && (
          <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5 whitespace-pre-wrap line-clamp-2">
            {task.description}
          </p>
        )}
        <div className="flex items-center gap-3 mt-1 text-[11px] text-gray-500 dark:text-gray-400">
          {dueDate && (
            <span className={isOverdue ? "text-rose-600 dark:text-rose-400 font-medium" : ""}>
              {isOverdue ? "Vencida " : "Vence "}
              {formatRelative(task.due_at!)}
            </span>
          )}
          {task.assignedUserName && (
            <span>· {task.assignedUserName}</span>
          )}
        </div>
      </div>
      {canManage && (
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            type="button"
            onClick={onEdit}
            disabled={busy}
            className="p-1.5 rounded text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-50"
            aria-label="Editar tarea"
            title="Editar"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="m18.5 2.5 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className="p-1.5 rounded text-gray-500 dark:text-gray-400 hover:bg-rose-50 dark:hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-400 disabled:opacity-50"
            aria-label="Eliminar tarea"
            title="Eliminar"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </div>
      )}
    </li>
  );
}
