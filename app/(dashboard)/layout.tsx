import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { Navbar } from "@/components/ui/navbar";
import { Sidebar } from "@/components/ui/sidebar";
import { NoAccessScreen } from "@/components/ui/no-access-screen";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();

  if (session.status === "no_auth") {
    redirect("/login");
  }

  if (session.status === "no_membership") {
    return <NoAccessScreen />;
  }

  const { data } = session;

  return (
    <div className="h-screen flex flex-col bg-gray-50 dark:bg-gray-900 overflow-hidden">
      <Navbar session={data} />
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <Sidebar role={data.activeOrg.role} />
        <main className="flex-1 min-w-0 min-h-0 overflow-y-auto p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
