"use client";
import { useEffect, useRef, useState } from "react";
import { resolvePostventaCaseAction } from "@/lib/actions/opportunities-m6";
import type { UUID } from "@/lib/types/database";

interface Props {
  open: boolean;
  opportunityId: UUID | null;
  onCancel: () => void;
  onSuccess: () => void;
}

/**
 * Modal de cierre de "Caso problemático" de Post-venta (M3v2).
 *
 * Mismo patrón visual que AddNoteDialog. La nota de resolución es
 * OPCIONAL (a diferencia de la nota manual). Al confirmar, el caso se
 * archiva (resolved_at) sin cambiar de etapa; el motor deja de tocarlo.
 */
export function ResolveCaseDialog({ open, opportunityId, onCancel, onSuccess }: Props) {
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
    setSubmitting(true);
    setError(null);
    const res = await resolvePostventaCaseAction({
      opportunityId,
      note: note.trim().length > 0 ? note.trim() : "",
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
      aria-labelledby="resolve-case-title"
      onClick={submitting ? undefined : onCancel}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6 outline-none"
      >
        <p
          id="resolve-case-title"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          Marcar caso como resuelto
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          El caso se archiva y sale del pipeline activo. Sigue siendo consultable
          en “Casos resueltos” y por búsqueda. La etapa no cambia.
        </p>

        <form onSubmit={handleSubmit} className="mt-4 space-y-3">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">
            Nota de resolución{" "}
            <span className="font-normal text-gray-400">(opcional)</span>
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={submitting}
            maxLength={2000}
            rows={4}
            autoFocus
            placeholder="¿Cómo se resolvió? (ej. reembolso procesado, cliente conforme)"
            className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:opacity-50"
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
              disabled={submitting}
              className="px-3 py-1.5 text-sm rounded-md bg-amber-600 text-white hover:bg-amber-700 disabled:bg-amber-300"
            >
              {submitting ? "Resolviendo..." : "Marcar como resuelto"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
