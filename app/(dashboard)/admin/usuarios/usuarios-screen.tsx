"use client";
import { useState } from "react";
import {
  activateUserAction,
  deactivateUserAction,
  resendInviteAction,
} from "@/lib/actions/admin-users";
import type { ManagedUserView } from "@/lib/types/admin";
import { UserEditModal } from "./user-edit-modal";
import { InviteVendorModal } from "./invite-vendor-modal";
import { LinkLoginModal } from "./link-login-modal";
import { DeactivateModal } from "./deactivate-modal";
import { RoleBadge, StateBadge, LoginBadge } from "./user-badges";

interface Props {
  initialUsers: ManagedUserView[];
}

/**
 * Pantalla admin de Usuarios (M9.2, Block 1). Lista los asesores
 * existentes (Gina/Pepe) + cualquiera invitado, con rol, estado, color
 * y email. "Histórico" no aparece (R10). Editar nombre/color/rol vía
 * modal. Invitar/vincular login y activar/desactivar se agregan en los
 * Blocks 2 y 3.
 */
export function UsuariosScreen({ initialUsers }: Props) {
  const [users, setUsers] = useState(initialUsers);
  const [editing, setEditing] = useState<ManagedUserView | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [linkUser, setLinkUser] = useState<ManagedUserView | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<{
    user: ManagedUserView;
    activeCount: number;
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [banner, setBanner] = useState<{
    tone: "error" | "success";
    text: string;
  } | null>(null);

  function openEdit(user: ManagedUserView) {
    setEditing(user);
    setModalOpen(true);
  }

  async function handleResend(user: ManagedUserView) {
    setBusyId(user.membershipId);
    const res = await resendInviteAction({ membershipId: user.membershipId });
    setBusyId(null);
    if (!res.ok) {
      setBanner({ tone: "error", text: res.message });
      return;
    }
    setUsers(res.users);
    setBanner({ tone: "success", text: `Invitación reenviada a ${user.email}.` });
  }

  async function handleDeactivate(user: ManagedUserView) {
    setBusyId(user.membershipId);
    const res = await deactivateUserAction({ membershipId: user.membershipId });
    setBusyId(null);
    if (res.ok) {
      setUsers(res.users);
      setBanner({ tone: "success", text: `${user.fullName} fue desactivado.` });
      return;
    }
    if (res.reason === "has_pending") {
      setDeactivateTarget({ user, activeCount: res.activeCount });
      return;
    }
    setBanner({ tone: "error", text: res.message });
  }

  async function handleActivate(user: ManagedUserView) {
    setBusyId(user.membershipId);
    const res = await activateUserAction({ membershipId: user.membershipId });
    setBusyId(null);
    if (!res.ok) {
      setBanner({ tone: "error", text: res.message });
      return;
    }
    setUsers(res.users);
    setBanner({ tone: "success", text: `${user.fullName} fue reactivado.` });
  }

  return (
    <div className="max-w-4xl mx-auto">
      <header className="flex items-center justify-between gap-4 mb-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            Usuarios
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            Gestiona tu equipo: roles, color del pipeline y acceso.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setInviteOpen(true)}
          className="px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 whitespace-nowrap"
        >
          + Invitar vendedor
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
        {users.map((u) => (
          <li
            key={u.membershipId}
            className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-3"
          >
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
              <RoleBadge role={u.role} />
              <StateBadge active={u.isActive} />
              <LoginBadge status={u.loginStatus} />
              {u.loginStatus === "placeholder" && (
                <button
                  type="button"
                  onClick={() => setLinkUser(u)}
                  className="px-2.5 py-1 text-xs rounded-md bg-orange-600 text-white hover:bg-orange-700"
                >
                  Vincular login
                </button>
              )}
              {u.loginStatus === "pending" && (
                <button
                  type="button"
                  onClick={() => handleResend(u)}
                  disabled={busyId === u.membershipId}
                  className="px-2.5 py-1 text-xs rounded-md border border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-900/20 disabled:opacity-50"
                >
                  {busyId === u.membershipId ? "Enviando..." : "Reenviar"}
                </button>
              )}
              <button
                type="button"
                onClick={() => openEdit(u)}
                className="px-2.5 py-1 text-xs rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                Editar
              </button>
              {!u.isSelf &&
                (u.isActive ? (
                  <button
                    type="button"
                    onClick={() => handleDeactivate(u)}
                    disabled={busyId === u.membershipId}
                    className="px-2.5 py-1 text-xs rounded-md border border-red-200 text-red-700 dark:border-red-800 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
                  >
                    {busyId === u.membershipId ? "..." : "Desactivar"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleActivate(u)}
                    disabled={busyId === u.membershipId}
                    className="px-2.5 py-1 text-xs rounded-md border border-green-200 text-green-700 dark:border-green-800 dark:text-green-300 hover:bg-green-50 dark:hover:bg-green-900/20 disabled:opacity-50"
                  >
                    {busyId === u.membershipId ? "..." : "Reactivar"}
                  </button>
                ))}
            </div>
          </li>
        ))}
      </ul>

      {users.length === 0 && (
        <div className="text-center py-16 text-gray-400 dark:text-gray-500">
          <p>No hay usuarios gestionables todavía.</p>
        </div>
      )}

      <UserEditModal
        open={modalOpen}
        user={editing}
        onClose={() => setModalOpen(false)}
        onSaved={(next) => {
          setUsers(next);
          setModalOpen(false);
          setBanner({ tone: "success", text: "Usuario actualizado." });
        }}
      />

      <InviteVendorModal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onInvited={(next, email) => {
          setUsers(next);
          setInviteOpen(false);
          setBanner({ tone: "success", text: `Invitación enviada a ${email}.` });
        }}
      />

      <LinkLoginModal
        open={linkUser !== null}
        user={linkUser}
        onClose={() => setLinkUser(null)}
        onLinked={(next, email) => {
          setUsers(next);
          setLinkUser(null);
          setBanner({ tone: "success", text: `Acceso enviado a ${email}.` });
        }}
      />

      <DeactivateModal
        open={deactivateTarget !== null}
        target={deactivateTarget?.user ?? null}
        activeCount={deactivateTarget?.activeCount ?? 0}
        candidates={users.filter(
          (c) =>
            c.isActive &&
            c.membershipId !== deactivateTarget?.user.membershipId,
        )}
        onClose={() => setDeactivateTarget(null)}
        onDone={(next) => {
          setUsers(next);
          setDeactivateTarget(null);
          setBanner({
            tone: "success",
            text: "Oportunidades reasignadas y vendedor desactivado.",
          });
        }}
      />
    </div>
  );
}
