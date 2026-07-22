import "server-only";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { hasTab, landingHref } from "@/lib/auth/capabilities";

/**
 * Gate por pestaña a nivel de página (0039). El layout de admin deja pasar a
 * cualquier rol con ALGUNA pestaña de administración; cada página admin llama
 * a esto con SU tab key para bloquear a un rol custom que tenga otras pestañas
 * de admin pero no esta. Un rol sin la pestaña se redirige a su aterrizaje.
 */
export async function requireTabOrRedirect(tabKey: string): Promise<void> {
  const session = await getSession();
  if (session.status !== "ok") redirect("/login");
  if (!hasTab(session.data.activeRole, tabKey)) {
    redirect(landingHref(session.data.activeRole));
  }
}
