"use client";
import { useEffect, useRef, useState } from "react";
import { reclassifyTagAction } from "@/lib/actions/admin-tags";
import type {
  TagMappingActionResult,
  TagMappingView,
  TagVendorOption,
} from "@/lib/types/admin";
import type { TagClassification } from "@/lib/types/database";

interface Props {
  open: boolean;
  tag: TagMappingView | null;
  vendors: TagVendorOption[];
  onClose: () => void;
  onSaved: (mappings: TagMappingView[]) => void;
}

/**
 * Modal de reclasificación de tag (M7.2, Bloque 5). Permite marcar la
 * tag como De vendedor (con dropdown de vendedores) o Informativa.
 * El dropdown ya viene filtrado: excluye al sistema "Histórico" (R10)
 * e incluye vendedores reales desactivados (con indicador).
 */
export function TagReclassifyModal({ open, tag, vendors, onClose, onSaved }: Props) {
  const [classification, setClassification] = useState<TagClassification>("informational");
  const [membershipId, setMembershipId] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !tag) return;
    setClassification(tag.classification);
    setMembershipId(tag.mapped_membership_id ?? "");
    setError(null);
    setSubmitting(false);
  }, [open, tag]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onClose();
    }
    window.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, submitting, onClose]);

  if (!open || !tag) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting || !tag) return;
    if (classification === "vendor" && !membershipId) {
      setError("Selecciona un vendedor.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const res: TagMappingActionResult = await reclassifyTagAction({
      normalizedTag: tag.normalized,
      originalTag: tag.original,
      classification,
      membershipId: classification === "vendor" ? membershipId : null,
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onSaved(res.mappings);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-gray-900/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tag-reclassify-title"
      onClick={submitting ? undefined : onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6 outline-none"
      >
        <p id="tag-reclassify-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Clasificar tag
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          <span className="font-medium">{tag.original}</span> · {tag.count} entidad
          {tag.count === 1 ? "" : "es"}
        </p>

        <form onSubmit={handleSubmit} className="mt-4 space-y-3">
          <fieldset className="space-y-2">
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
              <input
                type="radio"
                name="classification"
                checked={classification === "informational"}
                onChange={() => setClassification("informational")}
                disabled={submitting}
                className="text-indigo-600 focus:ring-indigo-500"
              />
              Informativa (no asigna vendedor)
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
              <input
                type="radio"
                name="classification"
                checked={classification === "vendor"}
                onChange={() => setClassification("vendor")}
                disabled={submitting}
                className="text-indigo-600 focus:ring-indigo-500"
              />
              De vendedor (atribuye al asesor)
            </label>
          </fieldset>

          {classification === "vendor" && (
            <label className="block">
              <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
                Vendedor
              </span>
              <select
                value={membershipId}
                onChange={(e) => setMembershipId(e.target.value)}
                disabled={submitting}
                className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100"
              >
                <option value="" disabled>
                  Selecciona un vendedor
                </option>
                {vendors.map((v) => (
                  <option key={v.membershipId} value={v.membershipId}>
                    {v.fullName}
                    {v.isActive ? "" : " (desactivado)"}
                  </option>
                ))}
              </select>
            </label>
          )}

          {error && (
            <div role="alert" className="px-3 py-2 rounded-md bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300 text-sm">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
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
              {submitting ? "Guardando..." : "Guardar"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
