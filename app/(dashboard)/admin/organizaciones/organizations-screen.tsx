"use client";
import { useState } from "react";
import type { OrganizationAdminView } from "@/lib/types/admin";
import { CreateOrganizationModal } from "./create-organization-modal";
import { RenameOrganizationModal } from "./rename-organization-modal";

interface Props {
  initialOrganizations: OrganizationAdminView[];
}

/**
 * Admin → Organizaciones (0048). Lista las organizaciones que el usuario
 * administra, deja renombrar la que sea y crear una nueva (que nace con
 * todos sus seeds y con el creador dentro como admin).
 *
 * El `slug` se muestra como dato de solo lectura a propósito: es lo que
 * identifica a la organización en el webhook de Post-venta y en los scripts,
 * así que el admin necesita VERLO, pero cambiarlo rompería ambos en silencio.
 */
export function OrganizationsScreen({ initialOrganizations }: Props) {
  const [orgs, setOrgs] = useState(initialOrganizations);
  const [renaming, setRenaming] = useState<OrganizationAdminView | null>(null);
  const [creating, setCreating] = useState(false);
  const [banner, setBanner] = useState<{ tone: "error" | "success"; text: string } | null>(
    null,
  );

  return (
    <div className="max-w-4xl mx-auto">
      <header className="flex items-center justify-between gap-4 mb-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            Organizaciones
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            Las tiendas que administras. Puedes cambiarles el nombre visible o
            dar de alta una nueva; las credenciales de cada una se capturan
            después en Integraciones.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 whitespace-nowrap"
        >
          + Nueva organización
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
        {orgs.map((o) => (
          <li
            key={o.id}
            className="flex flex-col gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-3"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {o.name}
              </span>
              {o.isActive && (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300">
                  Activa
                </span>
              )}
              <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400">
                {o.roleLabel}
              </span>
              <span className="text-xs text-gray-400 dark:text-gray-500">
                {o.memberCount} usuario{o.memberCount === 1 ? "" : "s"}
              </span>
              <div className="ml-auto">
                <button
                  type="button"
                  onClick={() => setRenaming(o)}
                  className="px-2.5 py-1 text-xs rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  Cambiar nombre
                </button>
              </div>
            </div>
            <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
              <div className="flex gap-1">
                <dt>Identificador:</dt>
                <dd className="font-mono text-gray-600 dark:text-gray-300">{o.slug}</dd>
              </div>
              <div className="flex gap-1">
                <dt>Shopify:</dt>
                <dd className="text-gray-600 dark:text-gray-300">
                  {o.shopifyStoreDomain ?? "sin conectar"}
                </dd>
              </div>
              <div className="flex gap-1">
                <dt>Whaapy:</dt>
                <dd className="text-gray-600 dark:text-gray-300">
                  {o.whaapyBusinessId ? "conectado" : "sin conectar"}
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>

      <p className="mt-4 text-xs text-gray-400 dark:text-gray-500">
        El identificador es interno y no se puede cambiar: lo usan el webhook
        de Whaapy Post-venta y los comandos de mantenimiento para saber de qué
        organización hablan.
      </p>

      <CreateOrganizationModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(next, created) => {
          setOrgs(next);
          setCreating(false);
          setBanner({
            tone: "success",
            text: `Organización "${created.name}" creada. Ya puedes cambiarte a ella desde el selector de arriba y conectar Shopify y Whaapy en Integraciones.`,
          });
        }}
      />

      <RenameOrganizationModal
        open={renaming !== null}
        organization={renaming}
        onClose={() => setRenaming(null)}
        onSaved={(next, name) => {
          setOrgs(next);
          setRenaming(null);
          setBanner({ tone: "success", text: `Ahora se llama "${name}".` });
        }}
      />
    </div>
  );
}
