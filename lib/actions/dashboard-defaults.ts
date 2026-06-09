import type { DashboardFiltersInput } from "./dashboard";

/**
 * Filtros default del dashboard (Funnel Venta, últimos 30 días, toda la
 * org). Vive FUERA del módulo "use server" — un archivo de server
 * actions solo puede exportar funciones async; este const debe estar
 * aparte para no romper el build (Next.js invalid-use-server-value).
 * El `import type` arriba se borra en compilación, así que no arrastra
 * el módulo server al bundle de quien lo importe.
 */
export const DEFAULT_DASHBOARD_FILTERS: DashboardFiltersInput = {
  preset: "30d",
  customFrom: null,
  customTo: null,
  advisor: "",
};
