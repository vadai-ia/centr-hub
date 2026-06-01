"use client";
import { useEffect, useRef, useState } from "react";
import { addNoteToOpportunityAction } from "@/lib/actions/opportunities-m6";
import type { UUID } from "@/lib/types/database";

interface Props {
  open: boolean;
  opportunityId: UUID | null;
  onCancel: () => void;
  onSuccess: () => void;
}

/**
 * Modal de nota manual (M6 — B9).
 *
 * Mismo patrón visual que `LossReasonModal`. La nota se persiste como
 * fila en `activities` con `activity_type='manual_note'`, lo que la
 * hace aparecer automáticamente en el timeline del contacto y de la
 * oportunidad (ver `lib/services/timeline.ts`).
 */
export function AddNoteDialog({ open, opportunityId, onCancel, onSuccess }: Props) {
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setNote("");
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
    const trimmed = note.trim();
    if (trimmed.length === 0) {
      setError("La nota no puede estar vacía.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const res = await addNoteToOpportunityAction({
      opportunityId,
      note: trimmed,
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
      aria-labelledby="add-note-title"
      onClick={submitting ? undefined : onCancel}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6 outline-none"
      >
        <p
          id="add-note-title"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          Agregar nota
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          La nota queda registrada en el timeline de la oportunidad y del contacto.
        </p>

        <form onSubmit={handleSubmit} className="mt-4 space-y-3">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={submitting}
            maxLength={5000}
            rows={5}
            autoFocus
            placeholder="Escribe la nota..."
            className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-400 disabled:opacity-50"
          />

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
              disabled={submitting || note.trim().length === 0}
              className="px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300"
            >
              {submitting ? "Guardando..." : "Guardar nota"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
