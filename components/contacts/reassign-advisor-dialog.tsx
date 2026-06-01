"use client";
import { useEffect, useRef, useState } from "react";
import {
  reassignAdvisorAction,
  type ReassignResult,
} from "@/lib/actions/contacts";
import type { AdvisorOption } from "@/lib/actions/contacts";
import type { UUID } from "@/lib/types/database";

interface Props {
  open: boolean;
  entityType: "contact" | "opportunity";
  entityId: UUID | null;
  /** Membership actual de la entidad (puede ser null = sin asignar). */
  currentMembershipId: UUID | null;
  advisors: AdvisorOption[];
  onCancel: () => void;
  onSuccess: () => void;
}

/**
 * Modal de reasignación de asesor (M6 — B7).
 *
 * El dropdown muestra los vendedores activos NO sistema (advisors
 * ya viene filtrado desde `listActiveRealVendors`) + opción
 * "Sin asignar". Solo admin invoca esta UI (los botones que
 * abren el modal están detrás de `canReassign` en B3/B4).
 *
 * Texto sutil aclara que reasignar el contacto NO cascadea a sus
 * oportunidades — punto a validar con Centr en operación real;
 * la cascada queda registrada como deuda futura.
 */
export function ReassignAdvisorDialog({
  open,
  entityType,
  entityId,
  currentMembershipId,
  advisors,
  onCancel,
  onSuccess,
}: Props) {
  const [selected, setSelected] = useState<UUID | "__none__">(
    currentMembershipId ?? "__none__",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setError(null);
      setSubmitting(false);
      return;
    }
    setSelected(currentMembershipId ?? "__none__");
    setError(null);
  }, [open, currentMembershipId]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onCancel();
    }
    window.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, submitting, onCancel]);

  if (!open || !entityId) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const newMembershipId: UUID | null = selected === "__none__" ? null : selected;
    const res: ReassignResult = await reassignAdvisorAction({
      entityType,
      entityId,
      newMembershipId,
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onSuccess();
  }

  const cascadeHint = entityType === "contact"
    ? "Reasignar afecta solo al contacto. Las oportunidades asignadas mantienen su asesor actual."
    : "Reasignar afecta solo a esta oportunidad. El contacto y las demás oportunidades del contacto no cambian.";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-gray-900/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reassign-title"
      onClick={submitting ? undefined : onCancel}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6 outline-none"
      >
        <p
          id="reassign-title"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          Reasignar asesor
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          {cascadeHint}
        </p>

        <form onSubmit={handleSubmit} className="mt-4 space-y-3">
          <label className="block">
            <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
              Asesor
            </span>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value as UUID | "__none__")}
              disabled={submitting}
              className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100"
            >
              <option value="__none__">Sin asignar</option>
              {advisors.map((a) => (
                <option key={a.membershipId} value={a.membershipId}>
                  {a.fullName}
                </option>
              ))}
            </select>
          </label>

          {error && (
            <div
              role="alert"
              className="px-3 py-2 rounded-md bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300 text-sm"
            >
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
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
              className="px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300"
            >
              {submitting ? "Guardando..." : "Reasignar"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
