"use client";
import { useEffect, useRef, useState } from "react";
import {
  editTaskAction,
  type OpportunityTaskItem,
} from "@/lib/actions/opportunities-m6";
import { DateTimePicker } from "@/components/ui/datetime-picker";

interface Props {
  open: boolean;
  task: OpportunityTaskItem | null;
  onCancel: () => void;
  onSuccess: () => void;
}

const TASK_TYPE_LABELS: Record<string, string> = {
  call: "Llamada",
  message: "Mensaje",
  quote: "Cotización",
  follow_up: "Seguimiento",
  meeting: "Reunión",
  other: "Otra",
};
const TASK_TYPES = ["call", "message", "quote", "follow_up", "meeting", "other"];

/**
 * Modal de edición de tarea existente (lote polish M6).
 */
export function EditTaskDialog({ open, task, onCancel, onSuccess }: Props) {
  const [taskType, setTaskType] = useState("follow_up");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueAt, setDueAt] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !task) {
      setSubmitting(false);
      setError(null);
      return;
    }
    setTaskType(task.task_type);
    setTitle(task.title);
    setDescription(task.description ?? "");
    setDueAt(task.due_at);
    setError(null);

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onCancel();
    }
    window.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, task, submitting, onCancel]);

  if (!open || !task) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!task || submitting) return;
    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0) {
      setError("El título no puede estar vacío.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const res = await editTaskAction({
      taskId: task.id,
      title: trimmedTitle,
      description: description.trim() || undefined,
      dueAt: dueAt ?? undefined,
      taskType: taskType as "call" | "message" | "quote" | "follow_up" | "meeting" | "other",
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onSuccess();
  }

  return (
    <div
      className="fixed inset-0 z-[58] flex items-center justify-center px-4 bg-gray-900/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-task-title"
      onClick={submitting ? undefined : onCancel}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl max-w-md w-full p-6 outline-none"
      >
        <p id="edit-task-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Editar tarea
        </p>

        <form onSubmit={handleSubmit} className="mt-4 space-y-3">
          <label className="block">
            <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Tipo</span>
            <select
              value={taskType}
              onChange={(e) => setTaskType(e.target.value)}
              disabled={submitting}
              className={inputClass}
            >
              {TASK_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TASK_TYPE_LABELS[t] ?? t}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
              Título <span className="text-red-600 dark:text-red-400">*</span>
            </span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={submitting}
              maxLength={200}
              required
              autoFocus
              className={inputClass}
            />
          </label>

          <label className="block">
            <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Descripción</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={submitting}
              maxLength={2000}
              rows={3}
              placeholder="opcional"
              className={inputClass}
            />
          </label>

          <div>
            <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Vence</span>
            <DateTimePicker
              value={dueAt}
              onChange={setDueAt}
              disabled={submitting}
              placeholder="Sin fecha"
            />
          </div>

          {error && (
            <div role="alert" className="px-3 py-2 rounded-md bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300 text-sm">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting}
              className="px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={submitting || title.trim().length === 0}
              className="px-3 py-1.5 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-300 transition-colors"
            >
              {submitting ? "Guardando..." : "Guardar"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const inputClass =
  "w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-50";
