"use client";
import { signOut } from "@/lib/actions/auth";

export function NoAccessScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 p-4">
      <div className="max-w-sm text-center space-y-4">
        <p className="text-gray-700 dark:text-gray-300 text-sm">
          Tu cuenta no tiene acceso a ninguna organización. Contacta al
          administrador.
        </p>
        <button
          type="button"
          onClick={() => signOut()}
          className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline underline-offset-2"
        >
          Cerrar sesión
        </button>
      </div>
    </div>
  );
}
