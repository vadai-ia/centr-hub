"use client";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  loadDashboardAction,
  type AdvisorOption,
  type DashboardFiltersInput,
  type DashboardLoadOk,
} from "@/lib/actions/dashboard";
import { resolveCustomPeriod } from "@/lib/time/period";
import { DashboardToolbar } from "./dashboard-toolbar";
import { DashboardVenta } from "./dashboard-venta";
import { DashboardPostventa } from "./dashboard-postventa";
import { AdvisorBreakdown } from "./advisor-breakdown";
import { DashboardExportModal } from "./dashboard-export-modal";
import type { DashboardData } from "@/lib/types/dashboard";
import type { Funnel } from "@/lib/types/database";

interface Toast {
  id: number;
  message: string;
  variant: "info" | "error";
}

export function DashboardScreen({
  initial,
  orgName,
}: {
  initial: DashboardLoadOk;
  orgName: string;
}) {
  const [filters, setFilters] = useState<DashboardFiltersInput>(() => ({
    funnel: initial.filters.funnel,
    preset: initial.filters.preset,
    customFrom: initial.filters.customFrom,
    customTo: initial.filters.customTo,
    advisor: initial.filters.advisorMembershipId ?? "",
  }));
  const [data, setData] = useState<DashboardData>(initial.data);
  const [advisors] = useState<AdvisorOption[]>(initial.advisors);
  const [isPending, startTransition] = useTransition();
  const [customError, setCustomError] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  const pushToast = useCallback((message: string, variant: Toast["variant"]) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, message, variant }]);
  }, []);

  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = setTimeout(() => setToasts((t) => t.slice(1)), 3500);
    return () => clearTimeout(timer);
  }, [toasts]);

  const fetchWith = useCallback(
    (next: DashboardFiltersInput) => {
      // Validación local del rango custom antes de pegarle al server.
      if (next.preset === "custom") {
        if (!next.customFrom || !next.customTo) {
          setFilters(next); // espera a que el usuario complete ambas fechas
          return;
        }
        const res = resolveCustomPeriod(next.customFrom, next.customTo);
        if (!res.ok) {
          setFilters(next);
          setCustomError(
            "La fecha 'desde' debe ser anterior o igual a 'hasta'.",
          );
          return;
        }
      }
      setCustomError(null);
      setFilters(next);
      startTransition(async () => {
        const result = await loadDashboardAction(next);
        if (result.ok) {
          setData(result.data);
        } else {
          pushToast(result.message, "error");
        }
      });
    },
    [pushToast],
  );

  function onFunnelChange(funnel: Funnel) {
    if (funnel === filters.funnel) return;
    // El asesor filtrado se reinicia al cambiar de funnel: los rankings
    // por vendedor difieren entre funnels y el drilldown solo aparece sin
    // filtro de asesor. Toast informativo (requisito M8.2).
    const advisorWasSet = !!filters.advisor && filters.advisor !== "";
    const next = { ...filters, funnel, advisor: "" };
    if (advisorWasSet) {
      pushToast(
        `Cambiaste a Funnel ${funnel === "venta" ? "Venta" : "Post-venta"}. Se reinició el filtro de asesor.`,
        "info",
      );
    }
    fetchWith(next);
  }

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-50">Dashboard</h1>
        <p className="text-sm text-gray-400 dark:text-gray-500">
          {data.period.startLabel} al {data.period.endLabel}
        </p>
      </div>

      <DashboardToolbar
        filters={filters}
        isAdmin={initial.isAdmin}
        advisors={advisors}
        pending={isPending}
        customError={customError}
        onFunnelChange={onFunnelChange}
        onPresetChange={(preset) => fetchWith({ ...filters, preset })}
        onCustomChange={(customFrom, customTo) =>
          fetchWith({ ...filters, preset: "custom", customFrom, customTo })
        }
        onAdvisorChange={(advisor) => fetchWith({ ...filters, advisor })}
        onExport={() => setExportOpen(true)}
      />

      {data.funnel === "venta" && data.venta ? (
        <DashboardVenta m={data.venta} />
      ) : null}
      {data.funnel === "post_venta" && data.postventa ? (
        <DashboardPostventa m={data.postventa} />
      ) : null}

      {data.advisorBreakdown ? (
        <AdvisorBreakdown rows={data.advisorBreakdown} funnel={data.funnel} />
      ) : null}

      {exportOpen ? (
        <DashboardExportModal
          data={data}
          orgName={orgName}
          advisorName={resolveAdvisorName(filters, advisors)}
          onClose={() => setExportOpen(false)}
        />
      ) : null}

      <div
        aria-live="polite"
        className="fixed bottom-4 right-4 z-40 flex flex-col gap-2 max-w-sm"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.variant === "error" ? "alert" : "status"}
            className={`rounded-md border px-3 py-2 text-sm shadow-md ${
              t.variant === "error"
                ? "bg-rose-50 text-rose-900 border-rose-200 dark:bg-rose-900/40 dark:text-rose-100 dark:border-rose-800"
                : "bg-sky-50 text-sky-900 border-sky-200 dark:bg-sky-900/40 dark:text-sky-100 dark:border-sky-800"
            }`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}

function resolveAdvisorName(
  filters: DashboardFiltersInput,
  advisors: AdvisorOption[],
): string | null {
  if (!filters.advisor || filters.advisor === "") return null;
  if (filters.advisor === "unassigned") return "Sin asignar";
  return advisors.find((a) => a.membershipId === filters.advisor)?.name ?? null;
}
