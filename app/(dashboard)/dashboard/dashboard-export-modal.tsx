"use client";
import { useMemo, useState } from "react";
import {
  buildExportModel,
  exportKpiOptions,
  generateExcel,
  generatePdf,
  type ExportFormat,
  type ExportKpiKey,
} from "@/lib/export/dashboard-export";
import type { DashboardData } from "@/lib/types/dashboard";

/**
 * Modal de exportación contextual (M8.2). Respeta los filtros activos
 * (vienen en `data`). El usuario elige formato (Excel/PDF) y desmarca
 * los KPIs que no quiere; todos vienen marcados por default. Bloquea
 * generar si no hay ninguno seleccionado. Generación 100% client-side
 * (libs cargadas con import() dinámico dentro de los generadores).
 */
export function DashboardExportModal({
  data,
  orgName,
  advisorName,
  onClose,
}: {
  data: DashboardData;
  orgName: string;
  advisorName: string | null;
  onClose: () => void;
}) {
  const options = useMemo(() => exportKpiOptions(data), [data]);
  const [format, setFormat] = useState<ExportFormat>("excel");
  const [selected, setSelected] = useState<Set<ExportKpiKey>>(
    () => new Set(options.map((o) => o.key)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(key: ExportKpiKey) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const noneSelected = selected.size === 0;

  async function handleGenerate() {
    if (noneSelected || busy) return;
    setBusy(true);
    setError(null);
    // Timeout defensivo: si la generación se cuelga (dataset patológico),
    // libera la UI con un mensaje claro en vez de quedar bloqueada.
    const timeout = setTimeout(() => {
      setError("La generación está tardando demasiado. Intenta con menos KPIs o un periodo más corto.");
      setBusy(false);
    }, 30000);
    try {
      const model = buildExportModel(data, selected, { orgName, advisorName });
      if (format === "excel") await generateExcel(model);
      else await generatePdf(model);
      clearTimeout(timeout);
      setBusy(false);
      onClose();
    } catch (e) {
      clearTimeout(timeout);
      setError("No se pudo generar el archivo. Vuelve a intentar.");
      setBusy(false);
      console.error("dashboard export failed", e);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Exportar reporte"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl bg-white dark:bg-gray-800 shadow-xl border border-gray-200 dark:border-gray-700"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-700/60 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-50">Exportar reporte</h2>
          <button type="button" aria-label="Cerrar" onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
            ✕
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1.5">Formato</p>
            <div className="inline-flex rounded-md border border-gray-200 dark:border-gray-700 p-0.5">
              {(["excel", "pdf"] as ExportFormat[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFormat(f)}
                  className={`px-3 py-1.5 text-sm rounded transition-colors ${
                    format === f
                      ? "bg-indigo-600 text-white"
                      : "text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                  }`}
                >
                  {f === "excel" ? "Excel" : "PDF"}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">KPIs a incluir</p>
              <div className="flex gap-2 text-xs">
                <button type="button" className="text-indigo-600 dark:text-indigo-400 hover:underline" onClick={() => setSelected(new Set(options.map((o) => o.key)))}>
                  Todos
                </button>
                <button type="button" className="text-gray-400 hover:underline" onClick={() => setSelected(new Set())}>
                  Ninguno
                </button>
              </div>
            </div>
            <div className="space-y-1">
              {options.map((o) => (
                <label key={o.key} className="flex items-center gap-2 py-1 px-2 rounded hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.has(o.key)}
                    onChange={() => toggle(o.key)}
                    className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="text-sm text-gray-700 dark:text-gray-200">{o.label}</span>
                </label>
              ))}
            </div>
          </div>

          {error ? <p className="text-xs text-rose-600 dark:text-rose-400" role="alert">{error}</p> : null}
        </div>

        <div className="px-5 py-4 border-t border-gray-100 dark:border-gray-700/60 flex items-center justify-between">
          <span className="text-xs text-gray-400 dark:text-gray-500">
            {noneSelected ? "Selecciona al menos un KPI" : `${selected.size} KPI(s) seleccionados`}
          </span>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={noneSelected || busy}
              className="px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy ? "Generando…" : "Descargar"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
