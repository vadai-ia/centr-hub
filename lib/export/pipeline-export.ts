import { DateTime } from "luxon";
import type { Funnel } from "@/lib/types/database";

/**
 * Exportación del tablero a Excel — **una hoja por columna del pipeline**.
 *
 * Lo que se pidió: poder trabajar el tablero fuera de la plataforma
 * (repartir la lista, llamar uno por uno, cruzarla con otra cosa). El export
 * del Dashboard entrega indicadores agregados; esto entrega las tarjetas.
 *
 * El libro se arma en el NAVEGADOR con un `import()` perezoso de exceljs,
 * igual que la exportación del Dashboard: la librería es pesada y no tiene
 * por qué viajar en el bundle de quien nunca exporta.
 */

export interface PipelineExportRow {
  contacto: string;
  telefono: string;
  email: string;
  asesor: string;
  /** Viene como string desde Postgres (numeric). null = sin monto. */
  monto: string | null;
  entroEtapaIso: string | null;
  cotizacion: string;
  pedido: string;
  referencia: string;
  esOutbound: boolean;
}

export interface PipelineExportStage {
  name: string;
  rows: PipelineExportRow[];
  /**
   * Cerradas que el tablero auto-oculta por antigüedad y que por tanto NO
   * van en la hoja. Se declara: una hoja "Ganada" vacía donde hay cientos
   * de ganadas se lee como un fallo del archivo.
   */
  hiddenClosed: number;
}

export interface PipelineExportData {
  organizationName: string;
  funnel: Funnel;
  currency: string;
  timezone: string;
  generatedAt: string;
  /** Qué recorte lleva el archivo, o null si trae el funnel completo. */
  scopeNote: string | null;
  /** Alguna etapa topó el límite: el archivo NO está completo. */
  truncated: boolean;
  stages: PipelineExportStage[];
}

export const FUNNEL_LABELS: Record<Funnel, string> = {
  venta: "Venta",
  post_venta: "Post-venta",
  outbound: "Outbound",
};

function dias(desdeIso: string | null, zona: string): number | "" {
  if (!desdeIso) return "";
  const d = DateTime.fromISO(desdeIso, { zone: zona });
  if (!d.isValid) return "";
  return Math.max(Math.floor(DateTime.now().setZone(zona).diff(d, "days").days), 0);
}

function fecha(iso: string | null, zona: string): string {
  if (!iso) return "";
  const d = DateTime.fromISO(iso, { zone: zona });
  return d.isValid ? d.toFormat("dd/LL/yyyy HH:mm") : "";
}

/**
 * Excel limita el nombre de hoja a 31 caracteres y prohíbe `: \ / ? * [ ]`.
 * Un nombre inválido no da error legible: revienta al escribir el libro.
 * Dos etapas que colapsen al mismo nombre se desambiguan con sufijo.
 */
export function sheetName(nombre: string, usados: Set<string>): string {
  const base = (nombre.replace(/[:\\/?*[\]]/g, "-").trim() || "Etapa").slice(0, 31);
  if (!usados.has(base)) {
    usados.add(base);
    return base;
  }
  for (let i = 2; i < 100; i++) {
    const alt = `${base.slice(0, 31 - String(i).length - 1)} ${i}`;
    if (!usados.has(alt)) {
      usados.add(alt);
      return alt;
    }
  }
  return base.slice(0, 29) + "99";
}

function fileBase(data: PipelineExportData): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const dia = DateTime.fromISO(data.generatedAt, { zone: data.timezone }).toFormat(
    "yyyy-LL-dd",
  );
  return `${slug(data.organizationName)}-${slug(FUNNEL_LABELS[data.funnel])}-${dia}`;
}

export async function generatePipelineExcel(data: PipelineExportData): Promise<void> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Centr Hub";
  wb.created = new Date();

  // Portada: qué es, de cuándo, y con qué recorte. Un archivo que circula
  // por correo sin eso se vuelve inservible en una semana — nadie recuerda
  // si venía filtrado ni de qué día es.
  const resumen = wb.addWorksheet("Resumen");
  resumen.columns = [
    { header: "Etapa", key: "etapa", width: 34 },
    { header: "Oportunidades", key: "n", width: 16 },
    { header: "Monto", key: "monto", width: 18 },
    { header: "Ocultas por antigüedad", key: "ocultas", width: 22 },
  ];
  resumen.getRow(1).font = { bold: true };

  const usados = new Set<string>(["Resumen"]);
  for (const etapa of data.stages) {
    const total = etapa.rows.reduce((acc, r) => acc + (Number(r.monto) || 0), 0);
    resumen.addRow({
      etapa: etapa.name,
      n: etapa.rows.length,
      monto: total,
      ocultas: etapa.hiddenClosed > 0 ? etapa.hiddenClosed : "",
    });

    const ws = wb.addWorksheet(sheetName(etapa.name, usados));
    ws.columns = [
      { header: "Contacto", key: "contacto", width: 30 },
      { header: "Teléfono", key: "telefono", width: 18 },
      { header: "Email", key: "email", width: 30 },
      { header: "Asesor", key: "asesor", width: 20 },
      { header: "Monto", key: "monto", width: 16 },
      { header: "Días en la etapa", key: "dias", width: 16 },
      { header: "Entró a la etapa", key: "entro", width: 18 },
      { header: "Cotización", key: "cotizacion", width: 16 },
      { header: "Pedido", key: "pedido", width: 14 },
      { header: "Referencia", key: "referencia", width: 16 },
      { header: "Outbound", key: "outbound", width: 10 },
    ];

    // Ordenadas por lo que lleva más tiempo parado: es la pregunta que se le
    // hace a una lista así.
    const filas = [...etapa.rows].sort((a, b) => {
      const da = dias(a.entroEtapaIso, data.timezone);
      const db = dias(b.entroEtapaIso, data.timezone);
      return (typeof db === "number" ? db : -1) - (typeof da === "number" ? da : -1);
    });
    for (const r of filas) {
      ws.addRow({
        contacto: r.contacto,
        telefono: r.telefono,
        email: r.email,
        asesor: r.asesor,
        monto: r.monto === null ? "" : Number(r.monto),
        dias: dias(r.entroEtapaIso, data.timezone),
        entro: fecha(r.entroEtapaIso, data.timezone),
        cotizacion: r.cotizacion,
        pedido: r.pedido,
        referencia: r.referencia,
        outbound: r.esOutbound ? "Sí" : "",
      });
    }

    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = {
      type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" },
    };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 11 } };
    // TEXTO, no número: Excel se come el "+" y los ceros a la izquierda, y la
    // lista queda inservible justo para lo único que se va a usar: llamar.
    ws.getColumn("telefono").numFmt = "@";
    ws.getColumn("monto").numFmt = `#,##0.00 "${data.currency}"`;
  }

  resumen.getColumn("monto").numFmt = `#,##0.00 "${data.currency}"`;
  resumen.addRow({});
  const totalFilas = data.stages.reduce((a, s) => a + s.rows.length, 0);
  resumen.addRow({ etapa: `Total: ${totalFilas} oportunidades` }).font = { bold: true };
  resumen.addRow({
    etapa: `${data.organizationName} · ${FUNNEL_LABELS[data.funnel]} · ${fecha(
      data.generatedAt,
      data.timezone,
    )}`,
  });
  if (data.scopeNote) {
    resumen.addRow({ etapa: data.scopeNote }).font = {
      italic: true, color: { argb: "FFB45309" },
    };
  }
  if (data.truncated) {
    resumen.addRow({
      etapa: "Alguna etapa superó el máximo exportable: el archivo NO está completo.",
    }).font = { bold: true, color: { argb: "FFB91C1C" } };
  }
  resumen.addRow({
    etapa:
      "Refleja el tablero con los filtros activos; no incluye canceladas. " +
      "\"Ocultas por antigüedad\" son cerradas que el tablero ya no muestra: " +
      "existen, pero no van en la hoja.",
  }).font = { italic: true, color: { argb: "FF6B7280" } };

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${fileBase(data)}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
