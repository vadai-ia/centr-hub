"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { inviteUserAction } from "@/lib/actions/admin-users";
import type { ManagedUserView, RoleOption } from "@/lib/types/admin";

interface Props {
  open: boolean;
  assignableRoles: RoleOption[];
  onClose: () => void;
  onInvited: (users: ManagedUserView[], email: string) => void;
}

// Paleta de arranque para el color del pipeline (distintos a Gina/Pepe).
const PALETTE = ["#F59E0B", "#10B981", "#8B5CF6", "#EF4444", "#06B6D4", "#F97316"];

/**
 * Modal "Invitar usuario" (0039). Crea un usuario NUEVO con el rol elegido:
 * envía la invitación por email (Supabase built-in) y da de alta su
 * membership. Para asesores YA existentes (Gina/Pepe) se usa "Vincular
 * login", no este modal.
 */
export function InviteUserModal({ open, assignableRoles, onClose, onInvited }: Props) {
  // Rol por defecto: vendedor si existe, si no el primero disponible.
  const defaultRole = useMemo(() => {
    if (assignableRoles.some((r) => r.key === "vendedor")) return "vendedor";
    return assignableRoles[0]?.key ?? "";
  }, [assignableRoles]);

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [color, setColor] = useState(PALETTE[0]);
  const [role, setRole] = useState(defaultRole);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setFullName("");
    setEmail("");
    setColor(PALETTE[0]);
    setRole(defaultRole);
    setError(null);
    setSubmitting(false);
  }, [open, defaultRole]);

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

  const selectedRole = assignableRoles.find((r) => r.key === role);
  const isAdvisorRole = role === "vendedor";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const res = await inviteUserAction({
      fullName: fullName.trim(),
      email: email.trim(),
      color,
      role,
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onInvited(res.users, email.trim());
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-gray-900/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="invite-title"
      onClick={submitting ? undefined : onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6 outline-none"
      >
        <p id="invite-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Invitar usuario
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          Le enviaremos un correo para que defina su contraseña y acceda con el
          rol seleccionado.
        </p>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <label className="block">
            <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
              Nombre
            </span>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              disabled={submitting}
              maxLength={120}
              required
              className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100"
            />
          </label>

          <label className="block">
            <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
              Email
            </span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
              required
              autoComplete="off"
              className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100"
            />
          </label>

          <label className="block">
            <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
              Rol
            </span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              disabled={submitting}
              className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100"
            >
              {assignableRoles.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
            <span className="block text-xs text-gray-400 dark:text-gray-500 mt-1">
              {selectedRole
                ? selectedRole.dataScope === "all"
                  ? "Verá y operará sobre los datos de toda la organización."
                  : "Verá y operará solo sobre lo asignado a esta persona."
                : ""}
              {!isAdvisorRole &&
                " No es asesor asignable (no entra al reparto ni al selector de asesor)."}
            </span>
          </label>

          <div>
            <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
              Color (pipeline)
            </span>
            <div className="flex items-center gap-2 flex-wrap">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  aria-label={`Color ${c}`}
                  aria-pressed={color === c}
                  className={`h-7 w-7 rounded-full transition-transform ${
                    color === c ? "ring-2 ring-offset-2 ring-indigo-500 dark:ring-offset-gray-800 scale-110" : ""
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
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
              disabled={submitting || !role}
              className="px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300"
            >
              {submitting ? "Enviando..." : "Enviar invitación"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
