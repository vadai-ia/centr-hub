"use client";
import { useEffect, useRef, useState } from "react";
import {
  updateUserAdvisorAction,
  updateUserEmailAction,
  updateUserProfileAction,
  updateUserRoleAction,
  updateUserRotationAction,
} from "@/lib/actions/admin-users";
import type { ManagedUserView, RoleOption } from "@/lib/types/admin";

interface Props {
  open: boolean;
  user: ManagedUserView | null;
  assignableRoles: RoleOption[];
  onClose: () => void;
  onSaved: (users: ManagedUserView[]) => void;
}

const HEX = /^#[0-9A-Fa-f]{6}$/;

/**
 * Modal de edición de usuario (M9.2, Block 1): nombre, correo, color (para el
 * pipeline), rol y las dos ranuras operativas (asesor y rotación de leads). El
 * rol se deshabilita para el propio admin y para superadmin. Guarda cada cosa
 * en acciones separadas; los guardrails (último admin, auto-rol, cartera viva)
 * viven en backend.
 *
 * ORDEN IMPORTANTE al guardar: el rol va PRIMERO, porque pasar a 'vendedor'
 * enciende la ranura de asesor en BD (trigger, 0050). Los toggles de asesor y
 * rotación se evalúan después contra el estado ya persistido.
 */
export function UserEditModal({ open, user, assignableRoles, onClose, onSaved }: Props) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [color, setColor] = useState("#6B7280");
  const [role, setRole] = useState<string>("vendedor");
  const [inRotation, setInRotation] = useState(true);
  const [isAdvisor, setIsAdvisor] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !user) return;
    setFullName(user.fullName);
    setEmail(user.email ?? "");
    setColor(HEX.test(user.color) ? user.color : "#6B7280");
    setRole(user.role);
    setInRotation(user.inLeadRotation);
    setIsAdvisor(user.isAdvisor);
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

    // Ranura de asesor (0050). El rol 'vendedor' la tiene siempre encendida y
    // no la ofrece la UI, así que aquí solo llegan los demás roles.
    if (user.role !== "vendedor" && isAdvisor !== user.isAdvisor) {
      const res = await updateUserAdvisorAction({
        membershipId: user.membershipId,
        isAdvisor,
      });
      if (!res.ok) {
        setSubmitting(false);
        setError(res.message);
        return;
      }
      latest = res.users;
    }

    // Toggle de rotación (solo asesores). Se aplica según el estado PERSISTIDO.
    if (user.isAdvisor && inRotation !== user.inLeadRotation) {
      const res = await updateUserRotationAction({
        membershipId: user.membershipId,
        inRotation,
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
              onChange={(e) => setRole(e.target.value)}
              disabled={submitting || roleLocked}
              className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100 disabled:opacity-60"
            >
              {user.role === "superadmin" && (
                <option value="superadmin">Superadmin</option>
              )}
              {assignableRoles.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
            {roleLocked && (
              <span className="block text-xs text-gray-400 dark:text-gray-500 mt-1">
                {user.isSelf
                  ? "No puedes cambiar tu propio rol."
                  : "El rol superadmin no se edita aquí."}
              </span>
            )}
          </label>

          {user.role !== "vendedor" && (
            <div className="rounded-md border border-gray-200 dark:border-gray-700 p-3">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isAdvisor}
                  onChange={(e) => setIsAdvisor(e.target.checked)}
                  disabled={submitting}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                />
                <span className="text-sm">
                  <span className="font-medium text-gray-900 dark:text-gray-100">
                    Opera oportunidades como asesor
                  </span>
                  <span className="block text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    Actívalo para quien vende además de su rol (por ejemplo una
                    líder que ascendió y conserva su cartera, o una dirección
                    que cotiza). Aparece en el selector de asesor, en el mapeo
                    de tags de Shopify, en el desglose del dashboard y en las
                    metas. Los vendedores lo tienen siempre activo.
                  </span>
                </span>
              </label>
            </div>
          )}

          {user.isAdvisor && (
            <div className="rounded-md border border-gray-200 dark:border-gray-700 p-3">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={inRotation}
                  onChange={(e) => setInRotation(e.target.checked)}
                  disabled={submitting}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                />
                <span className="text-sm">
                  <span className="font-medium text-gray-900 dark:text-gray-100">
                    Recibe leads por reparto automático
                  </span>
                  <span className="block text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    Entra a la rotación round-robin de leads que llegan por
                    formularios/campañas. Apágalo para que deje de recibir leads
                    automáticos (sigue tomándolos a mano y conserva los suyos).
                  </span>
                </span>
              </label>
            </div>
          )}

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
