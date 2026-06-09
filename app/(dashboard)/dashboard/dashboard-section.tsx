import type { ReactNode } from "react";

type Tone = "venta" | "postventa";

const TONE: Record<Tone, { bar: string; dot: string; chip: string }> = {
  venta: {
    bar: "from-indigo-500 to-emerald-500",
    dot: "bg-indigo-500",
    chip: "bg-indigo-50 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-200",
  },
  postventa: {
    bar: "from-amber-500 to-sky-500",
    dot: "bg-amber-500",
    chip: "bg-amber-50 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200",
  },
};

/**
 * Encabezado de sección del Dashboard (M8.2 rediseño #1/#2). Da
 * jerarquía visual y color con propósito a cada bloque (Venta /
 * Post-venta) para que el admin distinga las dos secciones de un
 * vistazo, sin toggle.
 */
export function DashboardSection({
  tone,
  title,
  subtitle,
  children,
}: {
  tone: Tone;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const t = TONE[tone];
  return (
    <section className="space-y-4">
      <div className="flex items-center gap-3">
        <span className={`h-7 w-1.5 rounded-full bg-gradient-to-b ${t.bar}`} aria-hidden />
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-50">{title}</h2>
          {subtitle ? (
            <p className="text-xs text-gray-500 dark:text-gray-400">{subtitle}</p>
          ) : null}
        </div>
      </div>
      {children}
    </section>
  );
}
