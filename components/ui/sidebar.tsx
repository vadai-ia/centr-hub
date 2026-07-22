"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  TAB_REGISTRY,
  type RoleCapabilities,
  type TabDef,
} from "@/lib/auth/capabilities";

interface Props {
  /** Capacidades del rol activo (0039). La nav se renderiza desde
   *  `allowedTabs`: cada rol ve exactamente sus pestañas, generales y de
   *  administración. */
  role: RoleCapabilities;
}

export function Sidebar({ role }: Props) {
  const pathname = usePathname();

  const allowed = TAB_REGISTRY.filter((t) => role.allowedTabs.includes(t.key));
  const generalTabs = allowed.filter((t) => t.section === "general");
  const adminTabs = allowed.filter((t) => t.section === "admin");

  function linkClass(href: string) {
    const active = pathname === href || pathname.startsWith(href + "/");
    return [
      "flex items-center px-3 py-2 rounded-md text-sm transition-colors",
      active
        ? "bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 font-medium"
        : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-gray-100",
    ].join(" ");
  }

  function renderTab(tab: TabDef) {
    return (
      <Link key={tab.href} href={tab.href} className={linkClass(tab.href)}>
        {tab.label}
      </Link>
    );
  }

  return (
    <aside className="w-56 flex-shrink-0 border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 flex flex-col overflow-y-auto">
      {/* Vendor + admin fluyen juntos arriba. El nav NO lleva flex-1
          (empujaba el bloque admin al fondo del aside, lejos de las
          pestañas). El spacer va DESPUÉS para ocupar el resto. */}
      <nav className="p-3 space-y-1">{generalTabs.map(renderTab)}</nav>

      {adminTabs.length > 0 && (
        <div className="border-t border-gray-200 dark:border-gray-700 mt-1 p-3">
          <p className="px-3 py-1 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-1">
            Administración
          </p>
          <nav className="space-y-1">{adminTabs.map(renderTab)}</nav>
        </div>
      )}

      <div className="flex-1" aria-hidden />
    </aside>
  );
}
