"use client";
import type { ManagedUserView } from "@/lib/types/admin";
import type { ISODateString } from "@/lib/types/database";
import {
  AdvisorBadge,
  RoleBadge,
  StateBadge,
  LoginBadge,
  PresenceBadge,
} from "./user-badges";

interface Props {
  user: ManagedUserView;
  /** Último latido vigente (0057). Viene del estado de presencia, que se
   *  refresca solo — NO de `user.lastSeenAt`, que es solo la semilla. */
  lastSeenAt: ISODateString | null;
  /** Reloj contra el que se evalúa "en línea". */
  now: ISODateString;
  timezone: string;
  /** Hay una acción en vuelo sobre ESTE usuario. */
  busy: boolean;
  onActivity: () => void;
  onEdit: () => void;
  onLinkLogin: () => void;
  onResend: () => void;
  onDeactivate: () => void;
  onActivate: () => void;
}

/**
 * Una fila del listado de Usuarios. Extraída de la pantalla para que ambos
 * archivos sigan bajo las 300 líneas: la pantalla se queda con el estado y
 * los modales, la fila con el render.
 */
export function UserRow({
  user: u,
  lastSeenAt,
  now,
  timezone,
  busy,
  onActivity,
  onEdit,
  onLinkLogin,
  onResend,
  onDeactivate,
  onActivate,
}: Props) {
  return (
    <li className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-3">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <span
          className="h-8 w-8 flex-shrink-0 rounded-full ring-2 ring-white dark:ring-gray-800 shadow"
          style={{ backgroundColor: u.color }}
          aria-hidden
        />
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
            {u.fullName}
            {u.isSelf && (
              <span className="ml-1.5 text-xs text-gray-400 dark:text-gray-500">
                (tú)
              </span>
            )}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
            {u.email ?? "Sin acceso configurado"}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <PresenceBadge lastSeenAt={lastSeenAt} now={now} timezone={timezone} />
        <RoleBadge role={u.role} label={u.roleLabel} />
        {u.isAdvisor && u.role !== "vendedor" && <AdvisorBadge />}
        <StateBadge active={u.isActive} />
        <LoginBadge status={u.loginStatus} />
        {u.loginStatus === "placeholder" && (
          <button
            type="button"
            onClick={onLinkLogin}
            className="px-2.5 py-1 text-xs rounded-md bg-orange-600 text-white hover:bg-orange-700"
          >
            Vincular login
          </button>
        )}
        {u.loginStatus === "pending" && (
          <button
            type="button"
            onClick={onResend}
            disabled={busy}
            className="px-2.5 py-1 text-xs rounded-md border border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-900/20 disabled:opacity-50"
          >
            {busy ? "Enviando..." : "Reenviar"}
          </button>
        )}
        <button
          type="button"
          onClick={onActivity}
          className="px-2.5 py-1 text-xs rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
        >
          Actividad
        </button>
        <button
          type="button"
          onClick={onEdit}
          className="px-2.5 py-1 text-xs rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
        >
          Editar
        </button>
        {!u.isSelf &&
          (u.isActive ? (
            <button
              type="button"
              onClick={onDeactivate}
              disabled={busy}
              className="px-2.5 py-1 text-xs rounded-md border border-red-200 text-red-700 dark:border-red-800 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
            >
              {busy ? "..." : "Desactivar"}
            </button>
          ) : (
            <button
              type="button"
              onClick={onActivate}
              disabled={busy}
              className="px-2.5 py-1 text-xs rounded-md border border-green-200 text-green-700 dark:border-green-800 dark:text-green-300 hover:bg-green-50 dark:hover:bg-green-900/20 disabled:opacity-50"
            >
              {busy ? "..." : "Reactivar"}
            </button>
          ))}
      </div>
    </li>
  );
}
