import { DateTime } from "luxon";
import { formatAmount } from "@/lib/format/money";
import { DASH, formatCount, formatDays, formatPercent } from "@/lib/format/dashboard";
import { DEFAULT_CURRENCY, TIMEZONE } from "@/lib/constants";
import type { DashboardData } from "@/lib/types/dashboard";

/**
 * Exportación contextual del Dashboard (M8.2) — client-side.
 *
 * Las librerías pesadas (exceljs / jspdf) se cargan con import()
 * dinámico dentro de los generadores, para que NO entren al bundle
 * inicial del dashboard (solo se descargan cuando el usuario exporta).
 *
 * El modelo intermedio (`ExportModel`) es neutral al formato: tanto el
 * generador Excel como el PDF lo consumen. Respeta los filtros activos
 * (vienen ya aplicados en `DashboardData`) y el header refleja el rango
 * y los filtros para que un tercero entienda el archivo sin la pantalla.
 */

const CCY = DEFAULT_CURRENCY;

export type ExportFormat = "excel" | "pdf";

/** Claves seleccionables en el modal (checkboxes). */
export type ExportKpiKey =
  // Venta
  | "revenue"
  | "quotesSent"
  | "pipelineGross"
  | "leads"
  | "qualifiedLeads"
  | "wonCount"
  | "activeWithDraft"
  | "winRateGlobal"
  | "lossRate"
  | "salesCycleDays"
  | "lossesByReason"
  | "winRateByStage"
  // Post-venta
  | "ordersCount"
  | "problematicCases"
  | "repurchaseRate"
  // Compartido
  | "advisorBreakdown";

export interface ExportKpiOption {
  key: ExportKpiKey;
  label: string;
}

export interface ExportSection {
  heading: string | null;
  columns: string[];
  rows: string[][];
}
export interface ExportModel {
  title: string;
  subtitle: string;
  emptyNote: string | null;
  sections: ExportSection[];
}

function fmtDate(label: string): string {
  const dt = DateTime.fromFormat(label, "yyyy-MM-dd", { zone: TIMEZONE });
  return dt.isValid ? dt.toFormat("dd/MM/yyyy") : label;
}

/** Opciones de KPI disponibles para el funnel/rol del dataset actual. */
export function exportKpiOptions(data: DashboardData): ExportKpiOption[] {
  const opts: ExportKpiOption[] = [];
  if (data.funnel === "venta") {
    opts.push(
      { key: "revenue", label: "Revenue cerrado" },
      { key: "quotesSent", label: "Cotizaciones enviadas" },
      { key: "pipelineGross", label: "Pipeline $ (bruto)" },
      { key: "leads", label: "Leads" },
      { key: "qualifiedLeads", label: "Leads calificados" },
      { key: "wonCount", label: "Oportunidades ganadas" },
      { key: "activeWithDraft", label: "Oportunidades activas (con cotización)" },
      { key: "winRateGlobal", label: "Win rate global" },
      { key: "lossRate", label: "Loss rate" },
      { key: "salesCycleDays", label: "Sales cycle promedio" },
      { key: "lossesByReason", label: "Pérdidas por motivo" },
      { key: "winRateByStage", label: "Win rate por etapa" },
    );
  } else {
    opts.push(
      { key: "ordersCount", label: "Pedidos" },
      { key: "problematicCases", label: "Casos problemáticos" },
      { key: "repurchaseRate", label: "Tasa de recompra" },
    );
  }
  if (data.advisorBreakdown && data.advisorBreakdown.length > 0) {
    opts.push({ key: "advisorBreakdown", label: "Desglose por vendedor" });
  }
  return opts;
}

interface BuildCtx {
  orgName: string;
  advisorName: string | null;
}

export function buildExportModel(
  data: DashboardData,
  selected: Set<ExportKpiKey>,
  ctx: BuildCtx,
): ExportModel {
  const funnelLabel = data.funnel === "venta" ? "Funnel Venta" : "Funnel Post-venta";
  const range = `${fmtDate(data.period.startLabel)} al ${fmtDate(data.period.endLabel)}`;
  const advisorPart = ctx.advisorName ? ` — Asesor: ${ctx.advisorName}` : " — Toda la organización";
  const subtitle = `${ctx.orgName} · ${range}${advisorPart}`;

  const sections: ExportSection[] = [];
  const scalar: string[][] = [];

  if (data.funnel === "venta" && data.venta) {
    const m = data.venta;
    const push = (key: ExportKpiKey, label: string, value: string) => {
      if (selected.has(key)) scalar.push([label, value]);
    };
    push("revenue", "Revenue cerrado", formatAmount(m.revenue, CCY) ?? DASH);
    push("quotesSent", "Cotizaciones enviadas", formatCount(m.quotesSent));
    push("pipelineGross", "Pipeline $ (bruto)", formatAmount(m.pipelineGross, CCY) ?? DASH);
    push("leads", "Leads", formatCount(m.leads));
    push("qualifiedLeads", "Leads calificados", formatCount(m.qualifiedLeads));
    push("wonCount", "Oportunidades ganadas", formatCount(m.wonCount));
    push("activeWithDraft", "Oportunidades activas (con cotización)", formatCount(m.activeWithDraft));
    push("winRateGlobal", "Win rate global", formatPercent(m.winRateGlobal));
    push("lossRate", "Loss rate", formatPercent(m.lossRate));
    push("salesCycleDays", "Sales cycle promedio", formatDays(m.salesCycleDays));
    if (scalar.length > 0) {
      sections.push({ heading: "Indicadores", columns: ["KPI", "Valor"], rows: scalar });
    }
    if (selected.has("lossesByReason")) {
      sections.push({
        heading: "Pérdidas por motivo",
        columns: ["Motivo", "Cantidad", "Monto"],
        rows: m.lossesByReason.map((r) => [
          r.reasonName,
          formatCount(r.count),
          formatAmount(r.amount, CCY) ?? DASH,
        ]),
      });
    }
    if (selected.has("winRateByStage")) {
      sections.push({
        heading: "Win rate por etapa",
        columns: ["Etapa", "Muestra", "% avanza"],
        rows: m.winRateByStage.map((s) => [
          s.stageName,
          formatCount(s.sample),
          s.smallSample ? "Muestra pequeña" : formatPercent(s.rate),
        ]),
      });
    }
  } else if (data.funnel === "post_venta" && data.postventa) {
    const m = data.postventa;
    if (selected.has("ordersCount")) scalar.push(["Pedidos", formatCount(m.ordersCount)]);
    if (selected.has("problematicCases")) scalar.push(["Casos problemáticos", formatCount(m.problematicCases)]);
    if (selected.has("repurchaseRate")) scalar.push(["Tasa de recompra", formatPercent(m.repurchaseRate)]);
    if (scalar.length > 0) {
      sections.push({ heading: "Indicadores", columns: ["KPI", "Valor"], rows: scalar });
    }
  }

  if (selected.has("advisorBreakdown") && data.advisorBreakdown) {
    const isVenta = data.funnel === "venta";
    sections.push({
      heading: "Desglose por vendedor",
      columns: isVenta
        ? ["Vendedor", "Revenue", "Cotiz.", "Ganadas", "Perdidas", "Win rate", "Pipeline $"]
        : ["Vendedor", "Pedidos", "Casos problemáticos"],
      rows: data.advisorBreakdown.map((r) =>
        isVenta
          ? [
              r.name,
              formatAmount(r.revenue, CCY) ?? DASH,
              formatCount(r.quotesSent),
              formatCount(r.wonCount),
              formatCount(r.lostCount),
              formatPercent(r.winRate),
              formatAmount(r.pipelineGross, CCY) ?? DASH,
            ]
          : [r.name, formatCount(r.ordersCount), formatCount(r.problematicCases)],
      ),
    });
  }

  const emptyNote = isDatasetEmpty(data) ? "Sin datos en el periodo seleccionado." : null;

  return {
    title: `Reporte ${funnelLabel}`,
    subtitle,
    emptyNote,
    sections,
  };
}

function isDatasetEmpty(data: DashboardData): boolean {
  if (data.funnel === "venta" && data.venta) {
    const m = data.venta;
    return (
      m.revenue === 0 &&
      m.quotesSent === 0 &&
      m.leads === 0 &&
      m.qualifiedLeads === 0 &&
      m.wonCount === 0 &&
      m.wonVsLost.lost === 0 &&
      m.pipelineGross === 0 &&
      m.activeWithDraft === 0
    );
  }
  if (data.funnel === "post_venta" && data.postventa) {
    const m = data.postventa;
    return m.ordersCount === 0 && m.problematicCases === 0;
  }
  return true;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function fileBase(model: ExportModel): string {
  // Sin unicode property escapes (\p{}) — el target de TS del proyecto
  // es < es6. ASCII-only es suficiente para el nombre de archivo.
  return model.title
    .toLowerCase()
    .replace(/[áàä]/g, "a")
    .replace(/[éèë]/g, "e")
    .replace(/[íìï]/g, "i")
    .replace(/[óòö]/g, "o")
    .replace(/[úùü]/g, "u")
    .replace(/ñ/g, "n")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export async function generateExcel(model: ExportModel): Promise<void> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.created = new Date(0); // determinista; la fecha del reporte va en el subtítulo
  const ws = wb.addWorksheet("Reporte");

  ws.addRow([model.title]);
  ws.getRow(1).font = { bold: true, size: 14 };
  ws.addRow([model.subtitle]);
  ws.getRow(2).font = { italic: true, size: 10, color: { argb: "FF6B7280" } };
  ws.addRow([]);
  if (model.emptyNote) {
    ws.addRow([model.emptyNote]);
    ws.lastRow!.font = { italic: true, color: { argb: "FFB45309" } };
    ws.addRow([]);
  }

  for (const section of model.sections) {
    if (section.heading) {
      const hr = ws.addRow([section.heading]);
      hr.font = { bold: true, size: 12 };
    }
    const headerRow = ws.addRow(section.columns);
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4F46E5" } };
      cell.alignment = { vertical: "middle" };
    });
    for (const row of section.rows) {
      ws.addRow(row);
    }
    ws.addRow([]);
  }

  // Ancho de columnas razonable.
  const maxCols = Math.max(2, ...model.sections.map((s) => s.columns.length));
  for (let c = 1; c <= maxCols; c++) {
    ws.getColumn(c).width = c === 1 ? 34 : 18;
  }

  const buffer = await wb.xlsx.writeBuffer();
  triggerDownload(
    new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    `${fileBase(model)}.xlsx`,
  );
}

export async function generatePdf(model: ExportModel): Promise<void> {
  const { jsPDF } = await import("jspdf");
  const autoTable = (await import("jspdf-autotable")).default;
  const doc = new jsPDF({ unit: "pt", format: "a4" });

  doc.setFontSize(16);
  doc.text(model.title, 40, 48);
  doc.setFontSize(10);
  doc.setTextColor(107, 114, 128);
  doc.text(model.subtitle, 40, 66);
  doc.setTextColor(0, 0, 0);

  let cursorY = 84;
  if (model.emptyNote) {
    doc.setFontSize(10);
    doc.setTextColor(180, 83, 9);
    doc.text(model.emptyNote, 40, cursorY);
    doc.setTextColor(0, 0, 0);
    cursorY += 18;
  }

  for (const section of model.sections) {
    if (section.heading) {
      cursorY += 18;
      doc.setFontSize(12);
      doc.setTextColor(31, 41, 55);
      doc.text(section.heading, 40, cursorY);
      doc.setTextColor(0, 0, 0);
      cursorY += 6;
    }
    autoTable(doc, {
      startY: cursorY,
      head: [section.columns],
      body:
        section.rows.length > 0
          ? section.rows
          : [["Sin datos", ...section.columns.slice(1).map(() => "")]],
      headStyles: { fillColor: [79, 70, 229], textColor: 255, fontStyle: "bold" },
      styles: { fontSize: 9, cellPadding: 4 },
      margin: { left: 40, right: 40 },
    });
    // @ts-expect-error lastAutoTable lo agrega el plugin en runtime.
    cursorY = doc.lastAutoTable.finalY + 8;
  }

  doc.save(`${fileBase(model)}.pdf`);
}
