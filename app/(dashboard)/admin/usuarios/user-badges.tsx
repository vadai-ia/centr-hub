"use client";
import type { UserLoginStatus } from "@/lib/types/admin";
import type { Role } from "@/lib/types/database";

/** Badges del listado de usuarios (M9.2). Extraídos para acotar la pantalla. */

export function RoleBadge({ role }: { role: Role }) {
  const label =
    role === "admin"
      ? "Administrador"
      : role === "superadmin"
        ? "Superadmin"
        : "Vendedor";
  const cls =
    role === "vendedor"
      ? "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
      : "bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300";
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
