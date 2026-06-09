import type { ReactNode } from "react";

type Tone = "venta" | "postventa";

const TONE: Record<
  Tone,
  { wrap: string; chip: string; icon: ReactNode }
> = {
  venta: {
    wrap: "bg-indigo-50/40 border-indigo-100 dark:bg-indigo-950/15 dark:border-indigo-900/30",
    chip: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-200",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden>
        <path d="M3 5h18l-7 8v6l-4-2v-4z" />
      </svg>
    ),
  },
  postventa: {
    wrap: "bg-amber-50/40 border-amber-100 dark:bg-amber-950/15 dark:border-amber-900/30",
    chip: "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-200",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden>
        <path d="M20 7.5 12 3 4 7.5v9L12 21l8-4.5z" />
        <path d="m8.5 5.2 7 4.1M4 7.5l8 4.5 8-4.5M12 12v9" />
      </svg>
    ),
  },
};

/**
 * Encabezado + envoltura de sección del Dashboard (M8.2 rediseño #1/#3).
 * Cada sección (Venta / Post-venta) es un "mundo" distinguible de un
 * vistazo: chip de ícono con su color de tono + título + subtítulo, y un
 * fondo de sección muy tenue (índigo Venta / ámbar Post-venta) que
 * envuelve las tarjetas. Sin toggle de funnel — ambas se ven juntas.
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
    <section className={`rounded-2xl border p-4 sm:p-5 ${t.wrap}`}>
      <div className="mb-4 flex items-center gap-3">
        <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${t.chip}`}>
          {t.icon}
        </span>
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-50">{title}</h2>
          {subtitle ? (
            <p className="text-xs text-gray-500 dark:text-gray-400">{subtitle}</p>
          ) : null}
        </div>
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}
