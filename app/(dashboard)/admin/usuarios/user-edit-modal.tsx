"use client";
import { useEffect, useRef, useState } from "react";
import {
  updateUserEmailAction,
  updateUserProfileAction,
  updateUserRoleAction,
} from "@/lib/actions/admin-users";
import type { ManagedUserView } from "@/lib/types/admin";

interface Props {
  open: boolean;
  user: ManagedUserView | null;
  onClose: () => void;
  onSaved: (users: ManagedUserView[]) => void;
}

const HEX = /^#[0-9A-Fa-f]{6}$/;

/**
 * Modal de edición de usuario (M9.2, Block 1): nombre, color (para el
 * pipeline) y rol (admin↔vendedor). El rol se deshabilita para el
 * propio admin y para superadmin. Guarda perfil y rol en acciones
 * separadas; los guardrails (último admin, auto-rol) viven en backend.
 */
export function UserEditModal({ open, user, onClose, onSaved }: Props) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [color, setColor] = useState("#6B7280");
  const [role, setRole] = useState<"admin" | "vendedor">("vendedor");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !user) return;
    setFullName(user.fullName);
    setEmail(user.email ?? "");
    setColor(HEX.test(user.color) ? user.color : "#6B7280");
    setRole(user.role === "admin" ? "admin" : "vendedor");
    setError(null);
    setSubmitting(false);
  }, [open, user]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onClose();
    }
    window.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, submitting, onClose]);

  if (!open || !user) return null;

  const roleLocked = user.isSelf || user.role === "superadmin";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting || !user) return;
    setSubmitting(true);
    setError(null);

    const emailTrimmed = email.trim();
    const emailChanged =
      emailTrimmed.toLowerCase() !== (user.email ?? "").toLowerCase();
    const nameOrColorChanged =
      fullName.trim() !== user.fullName || color !== user.color;
    const roleChanged = !roleLocked && role !== user.role;

    let latest: ManagedUserView[] | null = null;

    if (emailChanged) {
      if (!emailTrimmed) {
        setSubmitting(false);
        setError("El correo no puede quedar vacío (es el acceso del usuario).");
        return;
      }
      const res = await updateUserEmailAction({
        membershipId: user.membershipId,
        email: emailTrimmed,
      });
      if (!res.ok) {
        setSubmitting(false);
        setError(res.message);
        return;
      }
      latest = res.users;
    }

    if (roleChanged) {
      const res = await updateUserRoleAction({
        membershipId: user.membershipId,
        role,
      });
      if (!res.ok) {
        setSubmitting(false);
        setError(res.message);
        return;
      }
      latest = res.users;
    }

    if (nameOrColorChanged) {
      const res = await updateUserProfileAction({
        membershipId: user.membershipId,
        fullName: fullName.trim(),
        color,
      });
      if (!res.ok) {
        setSubmitting(false);
        setError(res.message);
        return;
      }
      latest = res.users;
    }

    setSubmitting(false);
    if (latest) {
      onSaved(latest);
    } else {
      onClose();
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-gray-900/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="user-edit-title"
      onClick={submitting ? undefined : onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6 outline-none"
      >
        <p
          id="user-edit-title"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          Editar usuario
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
              className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100"
            />
          </label>

          <label className="block">
            <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
              Correo (acceso / login)
            </span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
              autoComplete="off"
              spellCheck={false}
              placeholder="nombre@correo.com"
              className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100"
            />
            <span className="block text-xs text-gray-400 dark:text-gray-500 mt-1">
              {user.loginStatus === "active"
                ? "Si lo cambias, el vendedor deberá iniciar sesión con el correo nuevo (avísale)."
                : "Escribe el correo real del vendedor y luego envíale el acceso con “Reenviar”."}
            </span>
          </label>

          <div>
            <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
              Color (pipeline)
            </span>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value.toUpperCase())}
                disabled={submitting}
                aria-label="Selector de color"
                className="h-9 w-12 rounded border border-gray-200 dark:border-gray-700 bg-transparent p-0.5"
              />
              <input
                type="text"
                value={color}
                onChange={(e) => setColor(e.target.value.toUpperCase())}
                disabled={submitting}
                spellCheck={false}
                className="w-28 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 font-mono text-gray-900 dark:text-gray-100"
              />
            </div>
          </div>

          <label className="block">
            <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
              Rol
            </span>
            <select
              value={user.role === "superadmin" ? "superadmin" : role}
              onChange={(e) => setRole(e.target.value as "admin" | "vendedor")}
              disabled={submitting || roleLocked}
              className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100 disabled:opacity-60"
            >
              {user.role === "superadmin" && (
                <option value="superadmin">Superadmin</option>
              )}
              <option value="admin">Administrador</option>
              <option value="vendedor">Vendedor</option>
            </select>
            {roleLocked && (
              <span className="block text-xs text-gray-400 dark:text-gray-500 mt-1">
                {user.isSelf
                  ? "No puedes cambiar tu propio rol."
                  : "El rol superadmin no se edita aquí."}
              </span>
            )}
          </label>

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
              {submitting ? "Guardando..." : "Guardar"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
