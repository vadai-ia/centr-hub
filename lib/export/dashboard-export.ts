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
  | "ventaBreakdown"
  // Post-venta
  | "ordersCount"
  | "activeOrders"
  | "problematicCases"
  | "postventaBreakdown";

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

/**
 * Opciones de KPI disponibles (M8.2 ajuste #2: ambos funnels en un solo
 * reporte). El admin sin asesor filtrado además puede incluir el
 * desglose por vendedor de cada sección.
 */
export function exportKpiOptions(data: DashboardData): ExportKpiOption[] {
  const opts: ExportKpiOption[] = [
    // Venta
    { key: "revenue", label: "Venta · Revenue cerrado" },
    { key: "quotesSent", label: "Venta · Cotizaciones enviadas" },
    { key: "pipelineGross", label: "Venta · Pipeline $ (bruto)" },
    { key: "leads", label: "Venta · Leads" },
    { key: "qualifiedLeads", label: "Venta · Leads calificados" },
    { key: "wonCount", label: "Venta · Oportunidades ganadas" },
    { key: "activeWithDraft", label: "Venta · Oportunidades activas (con cotización)" },
    { key: "winRateGlobal", label: "Venta · Win rate global" },
    { key: "lossRate", label: "Venta · Loss rate" },
    { key: "salesCycleDays", label: "Venta · Sales cycle promedio" },
    { key: "lossesByReason", label: "Venta · Pérdidas por motivo" },
    { key: "winRateByStage", label: "Venta · Win rate por etapa" },
  ];
  if (data.ventaBreakdown && data.ventaBreakdown.length > 0) {
    opts.push({ key: "ventaBreakdown", label: "Venta · Desglose por vendedor" });
  }
  opts.push(
    { key: "ordersCount", label: "Post-venta · Pedidos (creados en periodo)" },
    { key: "activeOrders", label: "Post-venta · Pedidos activos ahora" },
    { key: "problematicCases", label: "Post-venta · Casos problemáticos" },
  );
  if (data.postventaBreakdown && data.postventaBreakdown.length > 0) {
    opts.push({ key: "postventaBreakdown", label: "Post-venta · Desglose por vendedor" });
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
  const range = `${fmtDate(data.period.startLabel)} al ${fmtDate(data.period.endLabel)}`;
  const advisorPart = ctx.advisorName ? ` — Asesor: ${ctx.advisorName}` : " — Toda la organización";
  const subtitle = `${ctx.orgName} · ${range}${advisorPart}`;

  const sections: ExportSection[] = [];

  // ---- Funnel Venta ----
  const v = data.venta;
  const ventaScalar: string[][] = [];
  const pushV = (key: ExportKpiKey, label: string, value: string) => {
    if (selected.has(key)) ventaScalar.push([label, value]);
  };
  pushV("revenue", "Revenue cerrado", formatAmount(v.revenue, CCY) ?? DASH);
  pushV("quotesSent", "Cotizaciones enviadas", formatCount(v.quotesSent));
  pushV("pipelineGross", "Pipeline $ (bruto)", formatAmount(v.pipelineGross, CCY) ?? DASH);
  pushV("leads", "Leads", formatCount(v.leads));
  pushV("qualifiedLeads", "Leads calificados", formatCount(v.qualifiedLeads));
  pushV("wonCount", "Oportunidades ganadas", formatCount(v.wonCount));
  pushV("activeWithDraft", "Oportunidades activas (con cotización)", formatCount(v.activeWithDraft));
  pushV("winRateGlobal", "Win rate global", formatPercent(v.winRateGlobal));
  pushV("lossRate", "Loss rate", formatPercent(v.lossRate));
  pushV("salesCycleDays", "Sales cycle promedio", formatDays(v.salesCycleDays));
  if (ventaScalar.length > 0) {
    sections.push({ heading: "Venta · Indicadores", columns: ["KPI", "Valor"], rows: ventaScalar });
  }
  if (selected.has("lossesByReason")) {
    sections.push({
      heading: "Venta · Pérdidas por motivo",
      columns: ["Motivo", "Cantidad", "Monto"],
      rows: v.lossesByReason.map((r) => [
        r.reasonName,
        formatCount(r.count),
        formatAmount(r.amount, CCY) ?? DASH,
      ]),
    });
  }
  if (selected.has("winRateByStage")) {
    sections.push({
      heading: "Venta · Win rate por etapa",
      columns: ["Etapa", "Muestra", "% avanza"],
      rows: v.winRateByStage.map((s) => [
        s.stageName,
        formatCount(s.sample),
        formatPercent(s.rate),
      ]),
    });
  }
  if (selected.has("ventaBreakdown") && data.ventaBreakdown) {
    sections.push({
      heading: "Venta · Desglose por vendedor",
      columns: ["Vendedor", "Revenue", "Cotiz.", "Ganadas", "Perdidas", "Win rate", "Pipeline $"],
      rows: data.ventaBreakdown.map((r) => [
        r.name,
        formatAmount(r.revenue, CCY) ?? DASH,
        formatCount(r.quotesSent),
        formatCount(r.wonCount),
        formatCount(r.lostCount),
        formatPercent(r.winRate),
        formatAmount(r.pipelineGross, CCY) ?? DASH,
      ]),
    });
  }

  // ---- Funnel Post-venta ----
  const p = data.postventa;
  const pvScalar: string[][] = [];
  if (selected.has("ordersCount")) pvScalar.push(["Pedidos (creados en periodo)", formatCount(p.ordersCount)]);
  if (selected.has("activeOrders")) pvScalar.push(["Pedidos activos ahora", formatCount(p.activeOrders)]);
  if (selected.has("problematicCases")) pvScalar.push(["Casos problemáticos", formatCount(p.problematicCases)]);
  if (pvScalar.length > 0) {
    sections.push({ heading: "Post-venta · Indicadores", columns: ["KPI", "Valor"], rows: pvScalar });
  }
  if (selected.has("postventaBreakdown") && data.postventaBreakdown) {
    sections.push({
      heading: "Post-venta · Desglose por vendedor",
      columns: ["Vendedor", "Pedidos", "Pedidos activos", "Casos problemáticos"],
      rows: data.postventaBreakdown.map((r) => [
        r.name,
        formatCount(r.ordersCount),
        formatCount(r.activeOrders),
        formatCount(r.problematicCases),
      ]),
    });
  }

  const emptyNote = isDatasetEmpty(data) ? "Sin datos en el periodo seleccionado." : null;

  return {
    title: "Reporte Dashboard",
    subtitle,
    emptyNote,
    sections,
  };
}

function isDatasetEmpty(data: DashboardData): boolean {
  const v = data.venta;
  const p = data.postventa;
  return (
    v.revenue === 0 &&
    v.quotesSent === 0 &&
    v.leads === 0 &&
    v.qualifiedLeads === 0 &&
    v.wonCount === 0 &&
    v.wonVsLost.lost === 0 &&
    v.pipelineGross === 0 &&
    v.activeWithDraft === 0 &&
    p.ordersCount === 0 &&
    p.activeOrders === 0 &&
    p.problematicCases === 0
  );
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
