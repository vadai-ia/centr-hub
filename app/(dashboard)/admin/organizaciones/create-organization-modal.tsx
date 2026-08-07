"use client";
import { useEffect, useRef, useState } from "react";
import { createOrganizationAction } from "@/lib/actions/admin-organizations";
import {
  ORG_SLUG_MAX_LENGTH,
  deriveOrgSlug,
  validateOrgSlug,
} from "@/lib/services/organization-slug";
import type { OrganizationAdminView } from "@/lib/types/admin";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (
    organizations: OrganizationAdminView[],
    created: { name: string; slug: string },
  ) => void;
}

/**
 * Modal de nueva organización (0048). Dos campos: el nombre visible y el
 * identificador, que se deriva del nombre en vivo y solo se toca si el admin
 * abre "ajustar". Se muestra aunque casi nunca se edite porque es INMUTABLE
 * tras crear — el único momento de elegirlo es este, y esconderlo dejaría al
 * admin sin saber que existe hasta que un script se lo pida.
 */
export function CreateOrganizationModal({ open, onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setSlug("");
    setSlugTouched(false);
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

  if (!open) return null;

  const effectiveSlug = slugTouched ? slug : deriveOrgSlug(name);
  const slugError = name.trim().length > 0 ? validateOrgSlug(effectiveSlug) : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const invalid = validateOrgSlug(effectiveSlug);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSubmitting(true);
    setError(null);
    const res = await createOrganizationAction({
      name: name.trim(),
      slug: effectiveSlug,
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onCreated(res.organizations, { name: res.created.name, slug: res.created.slug });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-gray-900/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-org-title"
      onClick={submitting ? undefined : onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-lg w-full p-6 outline-none max-h-[90vh] overflow-y-auto"
      >
        <p
          id="create-org-title"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          Nueva organización
        </p>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Nace con sus tres funnels y etapas, motivos de pérdida, reglas y
          catálogos por defecto. Tú quedas dentro como administrador.
        </p>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <label className="block">
            <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
              Nombre de la organización
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
              maxLength={80}
              required
              autoFocus
              placeholder="Ej. Centr Colombia"
              className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100"
            />
          </label>

          <div>
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-300">
                Identificador interno
              </span>
              {!slugTouched && (
                <button
                  type="button"
                  onClick={() => {
                    setSlug(effectiveSlug);
                    setSlugTouched(true);
                  }}
                  disabled={submitting}
                  className="text-xs underline text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                >
                  ajustar
                </button>
              )}
            </div>
            {slugTouched ? (
              <input
                type="text"
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase())}
                disabled={submitting}
                maxLength={ORG_SLUG_MAX_LENGTH}
                className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 font-mono text-gray-900 dark:text-gray-100"
              />
            ) : (
              <p className="w-full rounded-md border border-dashed border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 text-sm px-2 py-1.5 font-mono text-gray-600 dark:text-gray-300">
                {effectiveSlug || "—"}
              </p>
            )}
            <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
              No se puede cambiar después: es el nombre con el que el webhook de
              Whaapy Post-venta y los comandos de mantenimiento identifican a
              esta organización.
            </p>
            {slugError && (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{slugError}</p>
            )}
          </div>

          <div className="rounded-md bg-gray-50 dark:bg-gray-900/40 px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
            Nace sin conectar a Shopify ni a Whaapy. Cámbiate a ella desde el
            selector del encabezado y captura sus credenciales en{" "}
            <span className="font-medium text-gray-700 dark:text-gray-200">
              Administración → Integraciones
            </span>
            .
          </div>

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
              disabled={submitting || !!slugError || name.trim().length < 2}
              className="px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300"
            >
              {submitting ? "Creando..." : "Crear organización"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
