"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { switchOrganization } from "@/lib/actions/auth";
import type { OrgWithRole } from "@/lib/auth/session";

interface Props {
  orgs: OrgWithRole[];
  activeOrgId: string;
}

/**
 * Selector de organización activa. El cambio son DOS fases y ambas tienen
 * que mantener el control deshabilitado:
 *
 *  1. `switchOrganization` — escribe la cookie SSR y re-emite el JWT con el
 *     claim `organization_id` nuevo.
 *  2. `router.refresh()` — re-renderiza el árbol de servidor con esa
 *     organización. Corre DENTRO de `useTransition` porque `refresh()` es
 *     asíncrono y devuelve void: sin la transición no hay forma de saber
 *     cuándo terminó, y el select volvía a habilitarse mientras la pantalla
 *     todavía mostraba datos de la organización anterior.
 *
 * El remonte de las pantallas lo fuerza el `key` por org del layout — ver
 * `app/(dashboard)/layout.tsx`.
 */
export function OrgSelector({ orgs, activeOrgId }: Props) {
  const router = useRouter();
  const [switching, setSwitching] = useState(false);
  const [refreshing, startTransition] = useTransition();
  const busy = switching || refreshing;

  async function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const orgId = e.target.value;
    if (orgId === activeOrgId) return;
    setSwitching(true);
    try {
      await switchOrganization(orgId);
    } catch {
      // La organización no cambió: soltar el control para que el usuario
      // pueda reintentar en vez de quedarse con el select muerto.
      setSwitching(false);
      return;
    }
    startTransition(() => router.refresh());
    setSwitching(false);
  }

  return (
    <select
      value={activeOrgId}
      onChange={handleChange}
      disabled={busy}
      aria-busy={busy}
      className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 py-1 text-sm text-gray-700 dark:text-gray-300 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50 max-w-[180px] truncate"
      aria-label="Seleccionar organización"
    >
      {orgs.map((org) => (
        <option key={org.id} value={org.id}>
          {org.name}
        </option>
      ))}
    </select>
  );
}
