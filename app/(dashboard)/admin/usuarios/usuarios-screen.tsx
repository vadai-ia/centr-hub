"use client";
import { useEffect, useState } from "react";
import {
  activateUserAction,
  deactivateUserAction,
  resendInviteAction,
} from "@/lib/actions/admin-users";
import { loadTeamPresenceAction } from "@/lib/actions/presence";
import { PRESENCE_REFRESH_MS } from "@/lib/constants";
import type { ManagedUserView, RoleOption } from "@/lib/types/admin";
import type { ISODateString, UUID } from "@/lib/types/database";
import { UserEditModal } from "./user-edit-modal";
import { InviteUserModal } from "./invite-vendor-modal";
import { LinkLoginModal } from "./link-login-modal";
import { DeactivateModal } from "./deactivate-modal";
import { ActivityModal } from "./activity-modal";
import { UserRow } from "./user-row";

interface Props {
  initialUsers: ManagedUserView[];
  /** Roles asignables de la org (para invitar / editar) — 0039. */
  assignableRoles: RoleOption[];
  /** Reloj del servidor al armar la lista (0057) — contra él se evalúa
   *  "en línea" hasta el primer refresco. */
  serverNow: ISODateString;
  /** Zona de la organización, para el "hoy/ayer" de la última actividad. */
  timezone: string;
}

/**
 * Pantalla admin de Usuarios (M9.2, Block 1). Lista los asesores
 * existentes (Gina/Pepe) + cualquiera invitado, con rol, estado, color
 * y email. "Histórico" no aparece (R10). Editar nombre/color/rol vía
 * modal. Invitar/vincular login y activar/desactivar se agregan en los
 * Blocks 2 y 3.
 */
export function UsuariosScreen({
  initialUsers,
  assignableRoles,
  serverNow,
  timezone,
}: Props) {
  const [users, setUsers] = useState(initialUsers);
  const [activityUser, setActivityUser] = useState<ManagedUserView | null>(null);
  // Presencia (0057). Vive APARTE de `users` y se refresca sola: lo único
  // que cambia minuto a minuto es quién está conectado, y recargar la página
  // entera para eso cerraría cualquier modal abierto y perdería el banner.
  const [presence, setPresence] = useState<{
    now: ISODateString;
    lastSeen: Record<UUID, ISODateString>;
  }>({
    now: serverNow,
    lastSeen: Object.fromEntries(
      initialUsers
        .filter((u) => u.lastSeenAt !== null)
        .map((u) => [u.userId, u.lastSeenAt as ISODateString]),
    ),
  });
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

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      if (typeof document !== "undefined" && document.hidden) return;
      const res = await loadTeamPresenceAction();
      if (cancelled || !res.ok) return;
      setPresence({ now: res.now, lastSeen: res.lastSeen });
    }
    const timer = window.setInterval(refresh, PRESENCE_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

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
          + Invitar usuario
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
          <UserRow
            key={u.membershipId}
            user={u}
            lastSeenAt={presence.lastSeen[u.userId] ?? null}
            now={presence.now}
            timezone={timezone}
            busy={busyId === u.membershipId}
            onActivity={() => setActivityUser(u)}
            onEdit={() => openEdit(u)}
            onLinkLogin={() => setLinkUser(u)}
            onResend={() => void handleResend(u)}
            onDeactivate={() => void handleDeactivate(u)}
            onActivate={() => void handleActivate(u)}
          />
        ))}
      </ul>

      {users.length === 0 && (
        <div className="text-center py-16 text-gray-400 dark:text-gray-500">
          <p>No hay usuarios gestionables todavía.</p>
        </div>
      )}

      <ActivityModal
        open={activityUser !== null}
        user={activityUser}
        onClose={() => setActivityUser(null)}
      />

      <UserEditModal
        open={modalOpen}
        user={editing}
        assignableRoles={assignableRoles}
        onClose={() => setModalOpen(false)}
        onSaved={(next) => {
          setUsers(next);
          setModalOpen(false);
          setBanner({ tone: "success", text: "Usuario actualizado." });
        }}
      />

      <InviteUserModal
        open={inviteOpen}
        assignableRoles={assignableRoles}
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
            // Solo vendedores son asesores asignables (0039): un SDR/admin no
            // puede recibir oportunidades reasignadas.
            c.role === "vendedor" &&
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
