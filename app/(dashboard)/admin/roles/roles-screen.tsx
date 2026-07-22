"use client";
import { useState } from "react";
import { deleteRoleAction } from "@/lib/actions/admin-roles";
import { TAB_REGISTRY } from "@/lib/auth/capabilities";
import type { RoleAdminView } from "@/lib/types/admin";
import { RoleFormModal } from "./role-form-modal";

interface Props {
  initialRoles: RoleAdminView[];
}

const TAB_LABEL = new Map(TAB_REGISTRY.map((t) => [t.key, t.label]));

/**
 * Admin → Roles y permisos (0039). Lista los roles de la org (sistema +
 * custom), con su alcance de datos y sus pestañas. Crear/editar/borrar roles
 * custom; los de sistema (admin/vendedor/superadmin) son de solo lectura.
 */
export function RolesScreen({ initialRoles }: Props) {
  const [roles, setRoles] = useState(initialRoles);
  const [editing, setEditing] = useState<RoleAdminView | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ tone: "error" | "success"; text: string } | null>(null);

  async function handleDelete(role: RoleAdminView) {
    if (!confirm(`¿Borrar el rol "${role.label}"? Esta acción no se puede deshacer.`)) return;
    setBusyId(role.id);
    const res = await deleteRoleAction({ id: role.id });
    setBusyId(null);
    if (!res.ok) {
      setBanner({ tone: "error", text: res.message });
      return;
    }
    setRoles(res.roles);
    setBanner({ tone: "success", text: `Rol "${role.label}" borrado.` });
  }

  return (
    <div className="max-w-4xl mx-auto">
      <header className="flex items-center justify-between gap-4 mb-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            Roles y permisos
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            Define qué pestañas ve cada rol y si alcanza sus propios datos o los
            de toda la organización.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 whitespace-nowrap"
        >
          + Nuevo rol
        </button>
      </header>

      {banner && (
        <div
          role={banner.tone === "error" ? "alert" : "status"}
          className={`mb-3 px-3 py-2 rounded-md text-sm flex items-center justify-between gap-3 ${
            banner.tone === "error"
              ? "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300"
              : "bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300"
          }`}
        >
          <span>{banner.text}</span>
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="text-xs underline opacity-80 hover:opacity-100"
          >
            cerrar
          </button>
        </div>
      )}

      <ul className="space-y-2">
        {roles.map((r) => (
          <li
            key={r.id}
            className="flex flex-col gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-3"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {r.label}
              </span>
              {r.isSystem && (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400">
                  Sistema
                </span>
              )}
              <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300">
                {r.dataScope === "all" ? "Ve todos los datos" : "Solo sus datos"}
              </span>
              <span className="text-xs text-gray-400 dark:text-gray-500">
                {r.userCount} usuario{r.userCount === 1 ? "" : "s"}
              </span>
              <div className="ml-auto flex items-center gap-2">
                {!r.isSystem && (
                  <>
                    <button
                      type="button"
                      onClick={() => setEditing(r)}
                      className="px-2.5 py-1 text-xs rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
                    >
                      Editar
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(r)}
                      disabled={busyId === r.id}
                      className="px-2.5 py-1 text-xs rounded-md border border-red-200 text-red-700 dark:border-red-800 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
                    >
                      {busyId === r.id ? "..." : "Borrar"}
                    </button>
                  </>
                )}
              </div>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {r.allowedTabs.length === 0
                ? "Sin pestañas"
                : r.allowedTabs
                    .map((t) => TAB_LABEL.get(t) ?? t)
                    .join(" · ")}
            </p>
          </li>
        ))}
      </ul>

      <RoleFormModal
        open={creating}
        role={null}
        onClose={() => setCreating(false)}
        onSaved={(next) => {
          setRoles(next);
          setCreating(false);
          setBanner({ tone: "success", text: "Rol creado." });
        }}
      />

      <RoleFormModal
        open={editing !== null}
        role={editing}
        onClose={() => setEditing(null)}
        onSaved={(next) => {
          setRoles(next);
          setEditing(null);
          setBanner({ tone: "success", text: "Rol actualizado." });
        }}
      />
    </div>
  );
}
