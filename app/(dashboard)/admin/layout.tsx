import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (session.status !== "ok") redirect("/login");

  const { role } = session.data.activeOrg;
  if (role !== "admin" && role !== "superadmin") {
    redirect("/pipeline");
  }

  return <>{children}</>;
}
