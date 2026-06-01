import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { WhaapyFrame } from "./whaapy-frame";

/**
 * URL operativa del dashboard Whaapy de Centr (mayo 2026):
 * https://app.whaapy.com/inbox — landing directo al inbox de
 * conversaciones, no a la home. El env var sobreescribe completo
 * (path incluido) — el componente NO agrega `/inbox` por su cuenta;
 * pasa el valor tal cual al `src` del iframe.
 */
const DEFAULT_WHAAPY_URL = "https://app.whaapy.com/inbox";

/**
 * Pestaña Whaapy (M6 — B10).
 *
 * Server Component que resuelve la URL del iframe (env var opcional
 * `NEXT_PUBLIC_WHAAPY_DASHBOARD_URL` con fallback a `app.whaapy.com`)
 * y delega el render del iframe al Client.
 *
 * Operación esperada:
 *   - El vendedor abre la pestaña.
 *   - El iframe carga el dashboard de Whaapy. La sesión del navegador
 *     ya está autenticada en Whaapy (cookies nativas — no usamos la
 *     api_key server-side acá; CLAUDE.md clarifica que el iframe usa
 *     sesión nativa y la api_key cubre solo APIs salientes).
 *   - Si Whaapy bloquea iframe embedding (X-Frame-Options/CSP),
 *     el browser muestra error; el Client lo detecta vía `onError`
 *     y muestra mensaje + link directo.
 *
 * Budget de iteración (lección Kibah documentada en prompt M6):
 *   - Iteración 1 — URL simple, full-screen, sin parámetros.
 *   - Iteración 2 — si Whaapy permite query param tipo `?embed=1`,
 *     intentar añadirlo (no documentado por Whaapy actualmente).
 *   - Iteración 3 — fallback CSS: container scroll-x para "ocultar"
 *     el sidebar moviendo el iframe a `margin-left: -<width>`.
 *   - Tras 3 iteraciones sin éxito → ERRORES.md + deuda controlada.
 */
export default async function WhaapyPage() {
  const session = await getSession();
  if (session.status !== "ok") {
    redirect("/login");
  }
  const url = process.env.NEXT_PUBLIC_WHAAPY_DASHBOARD_URL ?? DEFAULT_WHAAPY_URL;
  return <WhaapyFrame url={url} />;
}
