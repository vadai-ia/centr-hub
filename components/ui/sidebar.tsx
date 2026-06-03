"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Role } from "@/lib/types/database";

// Alcance V1 (M7.2, Bloque 1). Mi Día, Reglas, Metas, Umbrales y
// Branding se posponen a V2: ocultos de la nav. Sus rutas redirigen
// limpio a /pipeline si se fuerza la URL directa.
const VENDOR_TABS = [
  { href: "/pipeline", label: "Pipeline" },
  { href: "/contactos", label: "Contactos" },
  { href: "/whaapy", label: "Whaapy" },
  { href: "/dashboard", label: "Dashboard" },
] as const;

const ADMIN_PAGES = [
  { href: "/admin/etapas", label: "Etapas del pipeline" },
  { href: "/admin/motivos", label: "Motivos de pérdida" },
  { href: "/admin/mapeo-tags", label: "Mapeo de tags" },
  { href: "/admin/usuarios", label: "Usuarios" },
] as const;

interface Props {
  role: Role;
}

export function Sidebar({ role }: Props) {
  const pathname = usePathname();
  const isAdmin = role === "admin" || role === "superadmin";

  function linkClass(href: string) {
    const active = pathname === href || pathname.startsWith(href + "/");
    return [
      "flex items-center px-3 py-2 rounded-md text-sm transition-colors",
      active
        ? "bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 font-medium"
        : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-gray-100",
    ].join(" ");
  }

  return (
    <aside className="w-56 flex-shrink-0 border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 flex flex-col overflow-y-auto">
      {/* Vendor + admin fluyen juntos arriba. El nav NO lleva flex-1
          (empujaba el bloque admin al fondo del aside, lejos de las
          pestañas). El spacer va DESPUÉS para ocupar el resto. */}
      <nav className="p-3 space-y-1">
        {VENDOR_TABS.map((tab) => (
          <Link key={tab.href} href={tab.href} className={linkClass(tab.href)}>
            {tab.label}
          </Link>
        ))}
      </nav>

      {isAdmin && (
        <div className="border-t border-gray-200 dark:border-gray-700 mt-1 p-3">
          <p className="px-3 py-1 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-1">
            Administración
          </p>
          <nav className="space-y-1">
            {ADMIN_PAGES.map((page) => (
              <Link
                key={page.href}
                href={page.href}
                className={linkClass(page.href)}
              >
                {page.label}
              </Link>
            ))}
          </nav>
        </div>
      )}

      <div className="flex-1" aria-hidden />
    </aside>
  );
}
