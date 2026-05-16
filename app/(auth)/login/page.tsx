import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/login-form";

export const metadata: Metadata = {
  title: "Iniciar sesión — Centr Hub",
};

export default function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  return (
    <div className="w-full max-w-sm space-y-6">
      <div className="text-center space-y-1">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
          Centr Hub
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Plataforma de ventas
        </p>
      </div>

      {searchParams.error === "link_expired" && (
        <div className="rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-700 dark:text-red-400">
          Este link expiró. Pide al administrador que te reenvíe la invitación.
        </div>
      )}

      {searchParams.error === "no_access" && (
        <div className="rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-700 dark:text-red-400">
          Tu cuenta no tiene acceso a ninguna organización. Contacta al
          administrador.
        </div>
      )}

      <LoginForm />

      <p className="text-center text-xs text-gray-400 dark:text-gray-500">
        <a
          href="/privacidad"
          className="underline underline-offset-2 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
        >
          Aviso de privacidad
        </a>
      </p>
    </div>
  );
}
