"use client";
import { useState } from "react";
import {
  exportPipelineAction,
  type ExportPipelineInput,
} from "@/lib/actions/pipeline-export";
import { FUNNEL_LABELS } from "@/lib/export/pipeline-export";

/**
 * "Exportar a Excel" del tablero: una hoja por columna del pipeline.
 *
 * El archivo se arma en el NAVEGADOR con un `import()` perezoso de exceljs
 * —igual que la exportación del Dashboard—, así que la librería solo se
 * descarga cuando alguien exporta de verdad.
 *
 * Se deshabilita mientras trabaja: un funnel completo tarda unos segundos y
 * sin eso la gente vuelve a hacer clic y se dispara la consulta dos veces.
 */
export function ExportPipelineButton({ input }: { input: ExportPipelineInput }) {
  const [estado, setEstado] = useState<"listo" | "trabajando">("listo");
  const [error, setError] = useState<string | null>(null);

  async function exportar() {
    setEstado("trabajando");
    setError(null);
    try {
      const res = await exportPipelineAction(input);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      if (res.data.stages.every((s) => s.rows.length === 0)) {
        setError("No hay oportunidades que exportar con los filtros actuales.");
        return;
      }
      // Perezoso a propósito: exceljs pesa y no tiene por qué viajar en el
      // bundle de quien nunca exporta.
      const { generatePipelineExcel } = await import("@/lib/export/pipeline-export");
      await generatePipelineExcel(res.data);
    } catch {
      setError("No se pudo generar el archivo. Intenta de nuevo.");
    } finally {
      setEstado("listo");
    }
  }

  return (
    <div className="flex items-center gap-2">
      {error && (
        <span className="text-xs text-amber-700 dark:text-amber-300" role="status">
          {error}
        </span>
      )}
      <button
        type="button"
        onClick={() => void exportar()}
        disabled={estado === "trabajando"}
        title={`Baja un Excel con las tarjetas de ${FUNNEL_LABELS[input.funnel]}, una hoja por columna. Respeta los filtros activos.`}
        className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2.5 py-1 text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-60 disabled:cursor-wait"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <path d="m7 10 5 5 5-5" />
          <path d="M12 15V3" />
        </svg>
        {estado === "trabajando" ? "Generando…" : "Exportar a Excel"}
      </button>
    </div>
  );
}
