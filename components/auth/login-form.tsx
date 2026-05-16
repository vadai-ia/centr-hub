"use client";
import { useEffect, useState } from "react";
import {
  signInWithPassword,
  signInWithMagicLink,
} from "@/lib/actions/auth";

type Mode = "password" | "magic";

export function LoginForm() {
  const [mode, setMode] = useState<Mode>("password");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  // null = still checking hash; true = no hash found, render form
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const hash = window.location.hash;
    if (hash && new URLSearchParams(hash.substring(1)).get("access_token")) {
      // Supabase sent auth tokens to /login instead of /auth/confirm.
      // Preserve the hash and hand off to the handler that knows what to do.
      window.location.replace("/auth/confirm" + hash);
      return;
    }
    setReady(true);
  }, []);

  // Don't render the form until we've confirmed there's no hash to redirect.
  // This prevents the login UI from flashing before the redirect fires.
  if (!ready) return null;

  async function handlePasswordSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setIsPending(true);
    const formData = new FormData(e.currentTarget);
    const result = await signInWithPassword(formData);
    // redirect() throws and unmounts — only runs if error returned
    if (result?.error) {
      setError(result.error);
      setIsPending(false);
    }
  }

  async function handleMagicSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setIsPending(true);
    const formData = new FormData(e.currentTarget);
    const result = await signInWithMagicLink(formData);
    setIsPending(false);
    if (result?.error) setError(result.error);
    else if (result?.success) setSuccess(result.success);
  }

  function toggleMode() {
    setMode((m) => (m === "password" ? "magic" : "password"));
    setError(null);
    setSuccess(null);
  }

  const inputClass =
    "w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500";

  const btnClass =
    "w-full rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors";

  const labelClass =
    "block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1";

  return (
    <div className="w-full space-y-4">
      {error && (
        <div className="rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded-md bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 p-3 text-sm text-green-700 dark:text-green-400">
          {success}
        </div>
      )}

      {mode === "password" && (
        <form onSubmit={handlePasswordSubmit} className="space-y-3">
          <div>
            <label htmlFor="email-pw" className={labelClass}>
              Correo electrónico
            </label>
            <input
              id="email-pw"
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="tu@empresa.com"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="password" className={labelClass}>
              Contraseña
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              placeholder="••••••••"
              className={inputClass}
            />
          </div>
          <button type="submit" disabled={isPending} className={btnClass}>
            {isPending ? "Entrando..." : "Entrar"}
          </button>
        </form>
      )}

      {mode === "magic" && (
        <form onSubmit={handleMagicSubmit} className="space-y-3">
          <div>
            <label htmlFor="email-magic" className={labelClass}>
              Correo electrónico
            </label>
            <input
              id="email-magic"
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="tu@empresa.com"
              className={inputClass}
            />
          </div>
          <button type="submit" disabled={isPending} className={btnClass}>
            {isPending ? "Enviando..." : "Enviar link de acceso"}
          </button>
          <p className="text-xs text-gray-500 dark:text-gray-400 text-center">
            Recibirás un link en tu correo para entrar sin contraseña.
          </p>
        </form>
      )}

      <button
        type="button"
        onClick={toggleMode}
        className="w-full text-center text-xs text-indigo-600 dark:text-indigo-400 hover:underline underline-offset-2"
      >
        {mode === "password"
          ? "¿Olvidaste tu contraseña? Inicia sesión sin contraseña"
          : "← Volver a iniciar con contraseña"}
      </button>
    </div>
  );
}
