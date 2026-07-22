"use client";
import type { UserLoginStatus } from "@/lib/types/admin";

/** Badges del listado de usuarios (M9.2). Extraídos para acotar la pantalla. */

/**
 * Badge de rol (0039). `role` es la key (sistema o custom) y `label` el
 * nombre visible (roles.label). Color por familia: vendedor azul,
 * admin/superadmin morado, roles custom (SDR, …) teal.
 */
export function RoleBadge({ role, label }: { role: string; label: string }) {
  const cls =
    role === "vendedor"
      ? "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
      : role === "admin" || role === "superadmin"
        ? "bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300"
        : "bg-teal-50 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300";
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}

export function StateBadge({ active }: { active: boolean }) {
  return (
    <span
      className={`px-2 py-0.5 rounded-full text-xs font-medium ${
        active
          ? "bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300"
          : "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400"
      }`}
    >
      {active ? "Activo" : "Inactivo"}
    </span>
  );
}

export function LoginBadge({ status }: { status: UserLoginStatus }) {
  const map: Record<UserLoginStatus, { label: string; cls: string }> = {
    active: {
      label: "Con acceso",
      cls: "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
    },
    pending: {
      label: "Invitación pendiente",
      cls: "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
    },
    placeholder: {
      label: "Sin login",
      cls: "bg-orange-50 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
    },
  };
  const { label, cls } = map[status];
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}
