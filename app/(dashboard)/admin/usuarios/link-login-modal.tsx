"use client";
import { useEffect, useRef, useState } from "react";
import { linkExistingAdvisorAction } from "@/lib/actions/admin-users";
import type { ManagedUserView } from "@/lib/types/admin";

interface Props {
  open: boolean;
  user: ManagedUserView | null;
  onClose: () => void;
  onLinked: (users: ManagedUserView[], email: string) => void;
}

/**
 * Modal "Vincular login" (M9.2, Block 2). Para asesores existentes
 * (Gina/Pepe) cuya fila de auth es un placeholder: repara la fila, le
 * fija el email real y le envía el link de definir contraseña — sin
 * duplicar su entidad de asesor (mismo user_id → atribuciones intactas).
 */
export function LinkLoginModal({ open, user, onClose, onLinked }: Props) {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !user) return;
    setEmail(user.email ?? "");
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting || !user) return;
    setSubmitting(true);
    setError(null);
    const res = await linkExistingAdvisorAction({
      membershipId: user.membershipId,
      email: email.trim(),
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onLinked(res.users, email.trim());
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-gray-900/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="link-title"
      onClick={submitting ? undefined : onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6 outline-none"
      >
        <p id="link-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Vincular login
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          Conecta un acceso a <span className="font-medium">{user.fullName}</span> sin
          crear un asesor nuevo. Conserva sus oportunidades y órdenes ya atribuidas.
        </p>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <label className="block">
            <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
              Email de acceso
            </span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
              required
              autoComplete="off"
              placeholder="nombre@correo.com"
              className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100"
            />
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
              {submitting ? "Vinculando..." : "Vincular y enviar acceso"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
