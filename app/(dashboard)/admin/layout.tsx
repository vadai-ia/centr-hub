import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { canAccessAdminPanel, landingHref } from "@/lib/auth/capabilities";

/**
 * Gate de entrada al panel de Administración (0039). Deja pasar a cualquier
 * rol con AL MENOS una pestaña de administración (admin/superadmin o un rol
 * custom con tabs de admin). El gate fino por pestaña vive en cada página
 * (`requireTabOrRedirect`) y en las server actions (`resolveAdminContext(tab)`).
 * Un rol sin ninguna pestaña de admin (vendedor, SDR) se redirige a su
 * pestaña de aterrizaje.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (session.status !== "ok") redirect("/login");

  if (!canAccessAdminPanel(session.data.activeRole)) {
    redirect(landingHref(session.data.activeRole));
  }

  return <>{children}</>;
}
