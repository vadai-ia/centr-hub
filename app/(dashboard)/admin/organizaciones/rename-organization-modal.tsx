"use client";
import { useEffect, useRef, useState } from "react";
import { renameOrganizationAction } from "@/lib/actions/admin-organizations";
import type { OrganizationAdminView } from "@/lib/types/admin";

interface Props {
  open: boolean;
  organization: OrganizationAdminView | null;
  onClose: () => void;
  onSaved: (organizations: OrganizationAdminView[], name: string) => void;
}

/**
 * Modal de cambio de nombre (0048). Un solo campo — el nombre visible. El
 * identificador se muestra al lado, deshabilitado, para dejar claro que NO
 * cambia: es el discriminador del webhook de Post-venta y de los scripts.
 * Ningún dato de negocio se mueve al renombrar.
 */
export function RenameOrganizationModal({
  open,
  organization,
  onClose,
  onSaved,
}: Props) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setName(organization?.name ?? "");
    setError(null);
    setSubmitting(false);
  }, [open, organization]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onClose();
    }
    window.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, submitting, onClose]);

  if (!open || !organization) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting || !organization) return;
    setSubmitting(true);
    setError(null);
    const res = await renameOrganizationAction({
      id: organization.id,
      name: name.trim(),
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onSaved(res.organizations, name.trim());
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-gray-900/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rename-org-title"
      onClick={submitting ? undefined : onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-lg w-full p-6 outline-none"
      >
        <p
          id="rename-org-title"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          Cambiar nombre
        </p>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Solo cambia cómo se llama en la plataforma. Sus oportunidades,
          pedidos, contactos y usuarios quedan intactos.
        </p>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <label className="block">
            <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
              Nombre visible
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
              maxLength={80}
              required
              autoFocus
              className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100"
            />
          </label>

          <label className="block">
            <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
              Identificador interno (no cambia)
            </span>
            <input
              type="text"
              value={organization.slug}
              disabled
              readOnly
              className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 text-sm px-2 py-1.5 font-mono text-gray-500 dark:text-gray-400"
            />
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
              onClick={onClose}
              disabled={submitting}
              className="px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={submitting || name.trim().length < 2}
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
