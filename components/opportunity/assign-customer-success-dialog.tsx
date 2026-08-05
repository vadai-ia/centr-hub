"use client";
import { useEffect, useRef, useState } from "react";
import {
  assignCustomerSuccessAction,
  type AssignCustomerSuccessResult,
} from "@/lib/actions/customer-success";
import type { AdvisorOption } from "@/lib/actions/contacts";
import type { UUID } from "@/lib/types/database";

interface Props {
  open: boolean;
  opportunityId: UUID | null;
  /** Customer Success actual de la oportunidad (null = sin asignar). */
  currentMembershipId: UUID | null;
  options: AdvisorOption[];
  onCancel: () => void;
  onSuccess: () => void;
}

/**
 * Modal de asignación del Customer Success de una oportunidad de
 * Post-venta (0047).
 *
 * Es la SEGUNDA ranura, no una reasignación: el asesor de venta de la
 * oportunidad no se toca. El texto del modal lo dice explícitamente para
 * que nadie lo confunda con "Reasignar asesor" (que sí mueve al vendedor).
 *
 * Un solo Customer Success por oportunidad es estructural (una columna):
 * elegir otro reemplaza al anterior. El backend revalida rol y funnel.
 */
export function AssignCustomerSuccessDialog({
  open,
  opportunityId,
  currentMembershipId,
  options,
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

  if (!open || !opportunityId) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const membershipId: UUID | null = selected === "__none__" ? null : selected;
    const res: AssignCustomerSuccessResult = await assignCustomerSuccessAction({
      opportunityId,
      membershipId,
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onSuccess();
  }

  const noOptions = options.length === 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-gray-900/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="assign-cs-title"
      onClick={submitting ? undefined : onCancel}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6 outline-none"
      >
        <p
          id="assign-cs-title"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          Asignar Customer Success
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          Se suma al asesor de la oportunidad, no lo reemplaza. Cada
          oportunidad tiene un solo Customer Success: elegir otro sustituye al
          actual.
        </p>

        <form onSubmit={handleSubmit} className="mt-4 space-y-3">
          <label className="block">
            <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
              Customer Success
            </span>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value as UUID | "__none__")}
              disabled={submitting || noOptions}
              className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100 disabled:opacity-60"
            >
              <option value="__none__">Sin asignar</option>
              {options.map((o) => (
                <option key={o.membershipId} value={o.membershipId}>
                  {o.fullName}
                </option>
              ))}
            </select>
          </label>

          {noOptions && (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              No hay usuarios con rol Customer Success activos. Crea uno desde
              Administración → Usuarios.
            </p>
          )}

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
              disabled={submitting || noOptions}
              className="px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300"
            >
              {submitting ? "Guardando..." : "Asignar"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
