"use client";
import { useEffect, useRef, useState } from "react";
import { createTaskForOpportunityAction } from "@/lib/actions/opportunities-m6";
import type { UUID } from "@/lib/types/database";

interface Props {
  open: boolean;
  opportunityId: UUID | null;
  onCancel: () => void;
  onSuccess: () => void;
}

/**
 * Tipos de tarea ofrecidos en el dropdown del modal (M6 — B9).
 *
 * El campo `tasks.task_type` en BD es text libre — la BD no impone
 * check constraint. Estos valores son convenciones del proyecto que
 * M9 (Mi Día) puede usar para agrupar visualmente. Reglas de M8
 * pueden generar otros tipos sin tocar este enum.
 */
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
 * Modal de creación de tarea manual (M6 — B9).
 *
 * La tarea queda asignada al usuario actual. M9 (Mi Día) lista esas
 * tareas. Si Centr en operación real necesita asignar a otro vendedor,
 * se cubre en F7/V2.
 */
export function CreateTaskDialog({ open, opportunityId, onCancel, onSuccess }: Props) {
  const [taskType, setTaskType] = useState<string>("follow_up");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState(""); // datetime-local format
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setTaskType("follow_up");
      setTitle("");
      setDescription("");
      setDueDate("");
      setSubmitting(false);
      setError(null);
      return;
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onCancel();
    }
    window.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, submitting, onCancel]);

  if (!open || !opportunityId) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting || !opportunityId) return;
    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0) {
      setError("El título no puede estar vacío.");
      return;
    }
    setSubmitting(true);
    setError(null);
    // datetime-local devuelve "YYYY-MM-DDTHH:mm" — convertimos a ISO.
    const dueAtIso = dueDate
      ? new Date(dueDate).toISOString()
      : undefined;
    const res = await createTaskForOpportunityAction({
      opportunityId,
      taskType: taskType as "call" | "message" | "quote" | "follow_up" | "meeting" | "other",
      title: trimmedTitle,
      description: description.trim() || undefined,
      dueAt: dueAtIso,
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
      className="fixed inset-0 z-[55] flex items-center justify-center px-4 bg-gray-900/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-task-title"
      onClick={submitting ? undefined : onCancel}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6 outline-none"
      >
        <p
          id="create-task-title"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          Crear tarea
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          La tarea se asigna a ti y aparece en &quot;Mi Día&quot;.
        </p>

        <form onSubmit={handleSubmit} className="mt-4 space-y-3">
          <label className="block">
            <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
              Tipo
            </span>
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
            <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
              Descripción
            </span>
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

          <label className="block">
            <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
              Vence
            </span>
            <input
              type="datetime-local"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              disabled={submitting}
              className={inputClass}
            />
            <span className="block text-[11px] text-gray-400 dark:text-gray-500 mt-1">
              Opcional. Se guarda en zona horaria local del navegador.
            </span>
          </label>

          {error && (
            <div
              role="alert"
              className="px-3 py-2 rounded-md bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300 text-sm"
            >
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
              className="px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300"
            >
              {submitting ? "Creando..." : "Crear tarea"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const inputClass =
  "w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-400 disabled:opacity-50";
