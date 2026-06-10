"use client";
import { useEffect, useRef, useState } from "react";
import { reassignActiveOpportunitiesAction } from "@/lib/actions/admin-users";
import type { ManagedUserView } from "@/lib/types/admin";
import type { UUID } from "@/lib/types/database";

interface Props {
  open: boolean;
  /** Usuario a desactivar (origen de la reasignación). */
  target: ManagedUserView | null;
  activeCount: number;
  /** Candidatos a recibir las opps: activos, no el propio target. */
  candidates: ManagedUserView[];
  onClose: () => void;
  onDone: (users: ManagedUserView[]) => void;
}

/**
 * Modal de desactivación con reasignación previa (M9.2, Block 3 —
 * opción C). El vendedor tiene N oportunidades activas; el admin elige a
 * quién pasárselas y al confirmar se reasignan (marcadas como manuales)
 * y se desactiva al origen.
 */
export function DeactivateModal({
  open,
  target,
  activeCount,
  candidates,
  onClose,
  onDone,
}: Props) {
  const [toId, setToId] = useState<UUID | "">("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setToId("");
    setError(null);
    setSubmitting(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onClose();
    }
    window.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, submitting, onClose]);

  if (!open || !target) return null;

  async function handleConfirm() {
    if (submitting || !target || toId === "") return;
    setSubmitting(true);
    setError(null);
    const res = await reassignActiveOpportunitiesAction({
      fromMembershipId: target.membershipId,
      toMembershipId: toId,
      deactivateAfter: true,
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onDone(res.users);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-gray-900/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="deactivate-title"
      onClick={submitting ? undefined : onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6 outline-none"
      >
        <p
          id="deactivate-title"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          Desactivar a {target.fullName}
        </p>
        <p className="text-sm text-gray-600 dark:text-gray-300 mt-2">
          Tiene <span className="font-medium">{activeCount}</span> oportunidad(es)
          activa(s). Para desactivarlo, reasígnalas a otro vendedor. La asignación
          queda como manual y no la pisan los procesos automáticos.
        </p>

        {candidates.length === 0 ? (
          <div
            role="alert"
            className="mt-4 px-3 py-2 rounded-md bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 text-sm"
          >
            No hay otro vendedor activo para recibir las oportunidades. Activa o
            invita a alguien primero.
          </div>
        ) : (
          <label className="block mt-4">
            <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
              Reasignar a
            </span>
            <select
              value={toId}
              onChange={(e) => setToId(e.target.value as UUID | "")}
              disabled={submitting}
              className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100"
            >
              <option value="">Selecciona un vendedor…</option>
              {candidates.map((c) => (
                <option key={c.membershipId} value={c.membershipId}>
                  {c.fullName}
                </option>
              ))}
            </select>
          </label>
        )}

        {error && (
          <div
            role="alert"
            className="mt-3 px-3 py-2 rounded-md bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300 text-sm"
          >
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={submitting || toId === "" || candidates.length === 0}
            className="px-3 py-1.5 text-sm rounded-md bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300"
          >
            {submitting ? "Procesando..." : "Reasignar y desactivar"}
          </button>
        </div>
      </div>
    </div>
  );
}
