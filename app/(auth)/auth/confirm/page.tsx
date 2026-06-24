"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

type PageState = "loading" | "set-password" | "redirecting" | "error";

type FlowType = "recovery" | "invite";

/**
 * Credencial con la que se establece la sesión al guardar la contraseña.
 * - `otp`: link directo a la app con `token_hash` (plantilla nueva, a prueba
 *   de escáneres). El token se consume SOLO en el submit vía `verifyOtp` —
 *   un GET pasivo de escáner nunca dispara el form, así que no lo quema.
 * - `session`: tokens en el hash (`#access_token`), flujo implícito legacy
 *   para correos en vuelo emitidos con la plantilla anterior.
 */
type AuthCredential =
  | { kind: "otp"; tokenHash: string; type: FlowType }
  | { kind: "session"; access: string; refresh: string };

export default function AuthConfirmPage() {
  const [pageState, setPageState] = useState<PageState>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [credential, setCredential] = useState<AuthCredential | null>(null);
  const [flow, setFlow] = useState<FlowType>("invite");
  const [password, setPassword] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [isPending, setIsPending] = useState(false);
  const router = useRouter();

  useEffect(() => {
    // 1) Flujo nuevo a prueba de escáneres: la plantilla apunta directo a
    //    /auth/confirm?token_hash=...&type=recovery|invite (query string).
    //    NO verificamos aquí — diferimos a `verifyOtp` en el submit para que
    //    un pre-fetch de escáner (GET sin enviar el form) no consuma el token.
    const query = new URLSearchParams(window.location.search);
    const queryTokenHash = query.get("token_hash");
    const queryType = query.get("type");

    if (
      queryTokenHash &&
      (queryType === "recovery" || queryType === "invite")
    ) {
      setCredential({
        kind: "otp",
        tokenHash: queryTokenHash,
        type: queryType,
      });
      setFlow(queryType);
      setPageState("set-password");
      return;
    }

    // 2) Flujo implícito legacy: tokens en el hash fragment.
    const rawHash = window.location.hash.substring(1); // strip leading '#'

    if (!rawHash) {
      setErrorMsg("Acceso inválido. Usa el link enviado a tu correo.");
      setPageState("error");
      return;
    }

    const params = new URLSearchParams(rawHash);
    const errorCode = params.get("error");

    if (errorCode) {
      const desc = params.get("error_description") ?? "Link inválido.";
      setErrorMsg(desc.replace(/\+/g, " "));
      setPageState("error");
      return;
    }

    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");
    const type = params.get("type");

    if (!accessToken || !refreshToken) {
      setErrorMsg("Link inválido o expirado. Solicita uno nuevo al administrador.");
      setPageState("error");
      return;
    }

    if (type === "invite" || type === "recovery") {
      setCredential({ kind: "session", access: accessToken, refresh: refreshToken });
      setFlow(type);
      setPageState("set-password");
      return;
    }

    // magiclink / email — set session and go straight to dashboard
    if (type === "magiclink" || type === "email") {
      const supabase = getSupabaseBrowserClient();
      supabase.auth
        .setSession({ access_token: accessToken, refresh_token: refreshToken })
        .then(({ error: sessionError }) => {
          if (sessionError) {
            setErrorMsg("Link expirado. Solicita un nuevo link de acceso.");
            setPageState("error");
          } else {
            setPageState("redirecting");
            router.push("/pipeline");
            router.refresh();
          }
        });
      return;
    }

    setErrorMsg("Tipo de verificación no reconocido.");
    setPageState("error");
  }, [router]);

  async function handleSetPassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!credential) return;

    setErrorMsg(null);

    if (password.length < 8) {
      setErrorMsg("La contraseña debe tener al menos 8 caracteres.");
      return;
    }
    if (password !== confirmPw) {
      setErrorMsg("Las contraseñas no coinciden.");
      return;
    }

    setIsPending(true);
    const supabase = getSupabaseBrowserClient();

    // Aquí — y solo aquí, en respuesta a una acción explícita del usuario —
    // se consume el token de un solo uso. Un escáner que pre-fetcheó el link
    // nunca llega a esta línea.
    const { error: sessionError } =
      credential.kind === "otp"
        ? await supabase.auth.verifyOtp({
            token_hash: credential.tokenHash,
            type: credential.type,
          })
        : await supabase.auth.setSession({
            access_token: credential.access,
            refresh_token: credential.refresh,
          });

    if (sessionError) {
      setErrorMsg(
        flow === "recovery"
          ? "Este link ya expiró o ya se usó. Solicita uno nuevo desde la pantalla de inicio de sesión."
          : "Este link ya expiró. Pide al administrador que te reenvíe la invitación.",
      );
      setIsPending(false);
      setPageState("error");
      return;
    }

    const { error: updateError } = await supabase.auth.updateUser({ password });

    if (updateError) {
      setErrorMsg("No se pudo establecer la contraseña. Intenta de nuevo.");
      setIsPending(false);
      return;
    }

    router.push("/pipeline");
    router.refresh();
  }

  // --- Shared styles ---
  const inputClass =
    "w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500";
  const labelClass =
    "block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1";

  if (pageState === "loading" || pageState === "redirecting") {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {pageState === "redirecting" ? "Entrando..." : "Verificando link..."}
      </p>
    );
  }

  if (pageState === "error") {
    return (
      <div className="w-full max-w-sm space-y-4">
        <div className="rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-700 dark:text-red-400">
          {errorMsg}
        </div>
        <a
          href="/login"
          className="block text-center text-sm text-indigo-600 dark:text-indigo-400 hover:underline underline-offset-2"
        >
          Ir al inicio de sesión
        </a>
      </div>
    );
  }

  const isRecovery = flow === "recovery";

  return (
    <div className="w-full max-w-sm space-y-6">
      <div className="text-center space-y-1">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
          Centr Hub
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {isRecovery
            ? "Define tu nueva contraseña."
            : "Define tu contraseña para activar tu cuenta."}
        </p>
      </div>

      {errorMsg && (
        <div className="rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-700 dark:text-red-400">
          {errorMsg}
        </div>
      )}

      <form onSubmit={handleSetPassword} className="space-y-3">
        <div>
          <label htmlFor="new-password" className={labelClass}>
            Nueva contraseña
          </label>
          <input
            id="new-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
            placeholder="Mínimo 8 caracteres"
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="confirm-password" className={labelClass}>
            Confirmar contraseña
          </label>
          <input
            id="confirm-password"
            type="password"
            value={confirmPw}
            onChange={(e) => setConfirmPw(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
            placeholder="Repite la contraseña"
            className={inputClass}
          />
        </div>
        <button
          type="submit"
          disabled={isPending}
          className="w-full rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isPending
            ? isRecovery
              ? "Guardando..."
              : "Activando cuenta..."
            : isRecovery
              ? "Guardar contraseña"
              : "Activar cuenta"}
        </button>
      </form>
    </div>
  );
}
