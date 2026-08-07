"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  TAB_REGISTRY,
  type RoleCapabilities,
  type TabDef,
} from "@/lib/auth/capabilities";
import { IconChevronDown, IconSettings, TabIcon } from "./nav-icons";

interface Props {
  /** Capacidades del rol activo (0039). La nav se renderiza desde
   *  `allowedTabs`: cada rol ve exactamente sus pestañas, generales y de
   *  administración. */
  role: RoleCapabilities;
}

const ADMIN_PREFIX = "/admin";

export function Sidebar({ role }: Props) {
  const pathname = usePathname();
  const onAdminRoute = pathname.startsWith(ADMIN_PREFIX);

  /** El bloque de administración es un desplegable: colapsado por
   *  defecto para que el menú no abra con una docena de opciones.
   *  Colapsado SIEMPRE al montar, incluso estando ya dentro de /admin —
   *  abrirlo es decisión explícita del usuario. Con el grupo cerrado
   *  sobre una ruta de admin, la cabecera se pinta con el estilo activo
   *  para no perder la referencia de dónde estás. */
  const [adminOpen, setAdminOpen] = useState(false);

  const allowed = TAB_REGISTRY.filter((t) => role.allowedTabs.includes(t.key));
  const generalTabs = allowed.filter((t) => t.section === "general");
  const adminTabs = allowed.filter((t) => t.section === "admin");

  function linkClass(href: string) {
    const active = pathname === href || pathname.startsWith(href + "/");
    return [
      "group flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors",
      active
        ? "bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 font-medium"
        : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-gray-100",
    ].join(" ");
  }

  function renderTab(tab: TabDef) {
    return (
      <Link key={tab.href} href={tab.href} className={linkClass(tab.href)}>
        <TabIcon tabKey={tab.key} className="h-[18px] w-[18px] flex-shrink-0" />
        <span className="truncate">{tab.label}</span>
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
          <button
            type="button"
            onClick={() => setAdminOpen((open) => !open)}
            aria-expanded={adminOpen}
            aria-controls="sidebar-admin-tabs"
            className={[
              "w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors",
              onAdminRoute && !adminOpen
                ? "bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 font-medium"
                : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-gray-100",
            ].join(" ")}
          >
            <IconSettings className="h-[18px] w-[18px] flex-shrink-0" />
            <span className="flex-1 text-left truncate">Administración</span>
            <IconChevronDown
              className={[
                "h-4 w-4 flex-shrink-0 transition-transform duration-200",
                adminOpen ? "rotate-180" : "",
              ].join(" ")}
            />
          </button>

          {adminOpen && (
            <nav id="sidebar-admin-tabs" className="mt-1 space-y-1">
              {adminTabs.map(renderTab)}
            </nav>
          )}
        </div>
      )}

      <div className="flex-1" aria-hidden />
    </aside>
  );
}
