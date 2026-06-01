"use client";
import { useEffect, useRef, useState } from "react";
import type { LossReasonOption } from "@/lib/types/pipeline";

interface Props {
  open: boolean;
  reasons: LossReasonOption[];
  onConfirm: (reasonId: string, note: string | null) => void;
  onCancel: () => void;
}

/**
 * Modal de motivo de pérdida (M5).
 *
 * Se muestra al soltar una card sobre una etapa cuyo
 * `requires_loss_reason = true`. Si el usuario cancela, la card
 * vuelve a su etapa anterior (rollback gestionado por el board).
 *
 * El catálogo de motivos viene del Server Component (cargado en
 * `loadInitialPipelineState`) — sin fetch adicional al abrir.
 */
export function LossReasonModal({
  open,
  reasons,
  onConfirm,
  onCancel,
}: Props) {
  const [reasonId, setReasonId] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setReasonId("");
      setNote("");
      return;
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-gray-900/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="loss-reason-title"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6 outline-none"
      >
        <p
          id="loss-reason-title"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          ¿Por qué se perdió?
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          Necesitamos un motivo para registrar correctamente la pérdida.
        </p>

        <div className="mt-4 space-y-3">
          <div>
            <label
              htmlFor="loss-reason-select"
              className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1"
            >
              Motivo
            </label>
            <select
              id="loss-reason-select"
              value={reasonId}
              onChange={(e) => setReasonId(e.target.value)}
              className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100"
            >
              <option value="" disabled>
                Selecciona un motivo
              </option>
              {reasons.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="loss-note"
              className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1"
            >
              Nota (opcional)
            </label>
            <textarea
              id="loss-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Detalles que ayuden a entender la pérdida"
              maxLength={2000}
              rows={3}
              className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => {
              if (!reasonId) return;
              onConfirm(reasonId, note.trim() ? note.trim() : null);
            }}
            disabled={!reasonId}
            className="px-3 py-1.5 text-sm rounded-md bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300 disabled:cursor-not-allowed"
          >
            Marcar como perdida
          </button>
        </div>
      </div>
    </div>
  );
}
