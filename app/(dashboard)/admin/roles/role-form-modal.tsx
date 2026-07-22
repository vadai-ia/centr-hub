"use client";
import { useEffect, useRef, useState } from "react";
import { createRoleAction, updateRoleAction } from "@/lib/actions/admin-roles";
import { TAB_REGISTRY, type DataScope } from "@/lib/auth/capabilities";
import type { RoleAdminView } from "@/lib/types/admin";

interface Props {
  open: boolean;
  /** null = crear; una fila = editar. */
  role: RoleAdminView | null;
  onClose: () => void;
  onSaved: (roles: RoleAdminView[]) => void;
}

const GENERAL_TABS = TAB_REGISTRY.filter((t) => t.section === "general");
const ADMIN_TABS = TAB_REGISTRY.filter((t) => t.section === "admin");

/**
 * Modal de crear/editar rol (0039). Dos ejes: alcance de datos (own/all) +
 * pestañas visibles (checkboxes por sección). El `key` es inmutable, así que
 * editar solo cambia label/scope/tabs. Los roles de sistema no llegan aquí
 * (la pantalla no ofrece el botón Editar para ellos).
 */
export function RoleFormModal({ open, role, onClose, onSaved }: Props) {
  const [label, setLabel] = useState("");
  const [dataScope, setDataScope] = useState<DataScope>("own");
  const [tabs, setTabs] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setLabel(role?.label ?? "");
    setDataScope(role?.dataScope ?? "own");
    setTabs(new Set(role?.allowedTabs ?? []));
    setError(null);
    setSubmitting(false);
  }, [open, role]);

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

  function toggleTab(key: string) {
    setTabs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const allowedTabs = Array.from(tabs);
    if (allowedTabs.length === 0) {
      setError("Elige al menos una pestaña — un rol sin pestañas deja al usuario sin acceso.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const payload = { label: label.trim(), dataScope, allowedTabs };
    const res = role
      ? await updateRoleAction({ id: role.id, ...payload })
      : await createRoleAction(payload);
    setSubmitting(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onSaved(res.roles);
  }

  function tabCheckbox(key: string, tabLabel: string) {
    return (
      <label key={key} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
        <input
          type="checkbox"
          checked={tabs.has(key)}
          onChange={() => toggleTab(key)}
          disabled={submitting}
          className="rounded border-gray-300 dark:border-gray-600"
        />
        {tabLabel}
      </label>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-gray-900/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="role-form-title"
      onClick={submitting ? undefined : onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-lg w-full p-6 outline-none max-h-[90vh] overflow-y-auto"
      >
        <p id="role-form-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {role ? "Editar rol" : "Nuevo rol"}
        </p>

        <form onSubmit={handleSubmit} className="mt-4 space-y-5">
          <label className="block">
            <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
              Nombre del rol
            </span>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              disabled={submitting}
              maxLength={60}
              required
              placeholder="Ej. SDR, Soporte, Supervisor"
              className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100"
            />
          </label>

          <fieldset>
            <legend className="text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
              Alcance de datos
            </legend>
            <div className="space-y-1.5">
              <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200">
                <input
                  type="radio"
                  name="data-scope"
                  checked={dataScope === "own"}
                  onChange={() => setDataScope("own")}
                  disabled={submitting}
                  className="mt-0.5"
                />
                <span>
                  Solo sus datos
                  <span className="block text-xs text-gray-400 dark:text-gray-500">
                    Ve y opera únicamente lo asignado a esa persona.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200">
                <input
                  type="radio"
                  name="data-scope"
                  checked={dataScope === "all"}
                  onChange={() => setDataScope("all")}
                  disabled={submitting}
                  className="mt-0.5"
                />
                <span>
                  Todos los datos de la organización
                  <span className="block text-xs text-gray-400 dark:text-gray-500">
                    Ve y opera sobre lo de todos (como un admin en las pestañas
                    generales).
                  </span>
                </span>
              </label>
            </div>
          </fieldset>

          <fieldset>
            <legend className="text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
              Pestañas visibles
            </legend>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1.5">Generales</p>
            <div className="grid grid-cols-2 gap-1.5 mb-3">
              {GENERAL_TABS.map((t) => tabCheckbox(t.key, t.label))}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1.5">Administración</p>
            <div className="grid grid-cols-2 gap-1.5">
              {ADMIN_TABS.map((t) => tabCheckbox(t.key, t.label))}
            </div>
          </fieldset>

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
              disabled={submitting}
              className="px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300"
            >
              {submitting ? "Guardando..." : role ? "Guardar" : "Crear rol"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
