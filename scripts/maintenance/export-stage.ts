/* eslint-disable no-console */
/**
 * Exporta a Excel las oportunidades de UNA etapa del pipeline.
 *
 * Para qué: la dirección pide "sácame en Excel lo que hay en la columna
 * Cold". El tablero se ve pero no se puede trabajar fuera de la plataforma
 * —repartir la lista, llamar uno por uno, cruzarla con otra cosa— y el
 * export del Dashboard entrega indicadores agregados, no las tarjetas.
 *
 * Lectura PURA: no escribe nada en la base.
 *
 * Decisiones:
 *   - **Excluye canceladas** (CLAUDE.md "Cancelado ≠ Perdido"), igual que el
 *     kanban: lo exportado tiene que ser lo que esa columna MUESTRA. Con
 *     `--incluir-canceladas` se añaden, para auditoría.
 *   - **"Días en la etapa"** sale de la última entrada a ESA etapa en el
 *     historial, no de la creación de la oportunidad: en Cold lo que importa
 *     es cuánto lleva enfriándose, no cuándo nació.
 *   - El teléfono va como TEXTO. Excel convierte `+5255…` en número y se
 *     come el `+` y los ceros a la izquierda — la lista queda inservible
 *     justo para lo único que se va a usar: llamar.
 *
 * Uso:
 *   # Ver qué etapas hay (sin --etapa las lista con su conteo)
 *   npm run maintenance:export-stage -- --org-slug centr
 *
 *   npm run maintenance:export-stage -- --org-slug centr --etapa "Cold"
 *   npm run maintenance:export-stage -- --org-slug centr --etapa "Cold" --salida "C:/ruta/cold.xlsx"
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { DateTime } from "luxon";
import ExcelJS from "exceljs";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { readOrganizationTimezone } from "@/lib/services/organization-timezone";
import { readOrganizationCurrency } from "@/lib/services/organization-currency";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

/** Acentos y mayúsculas fuera: "cotización" encuentra "Cotización". */
function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function dias(desde: string | null, zona: string): number | null {
  if (!desde) return null;
  const d = DateTime.fromISO(desde, { zone: zona });
  if (!d.isValid) return null;
  return Math.max(Math.floor(DateTime.now().setZone(zona).diff(d, "days").days), 0);
}

function fecha(iso: string | null, zona: string): string {
  if (!iso) return "";
  const d = DateTime.fromISO(iso, { zone: zona });
  return d.isValid ? d.toFormat("dd/LL/yyyy HH:mm") : "";
}

async function main() {
  const slug = arg("org-slug");
  const etapaPedida = arg("etapa");
  const incluirCanceladas = process.argv.includes("--incluir-canceladas");
  if (!slug) {
    console.error("Falta --org-slug");
    process.exit(1);
  }
  const org = await getOrganizationBySlug(slug);
  if (!org) {
    console.error(`No existe la organización "${slug}".`);
    process.exit(1);
  }
  const zona = readOrganizationTimezone(org.config);
  const moneda = readOrganizationCurrency(org.config);
  const sb = getSupabaseAdminClient();

  const { data: stageRows, error: stErr } = await sb
    .from("pipeline_stages")
    .select("id, name, funnel, position")
    .eq("organization_id", org.id)
    .order("funnel")
    .order("position");
  if (stErr) throw stErr;
  const stages = (stageRows ?? []) as Array<{
    id: string; name: string; funnel: string; position: number;
  }>;

  const etapa = etapaPedida
    ? stages.find((s) => normalizar(s.name) === normalizar(etapaPedida))
    : null;

  if (!etapa) {
    if (etapaPedida) console.error(`No hay una etapa llamada "${etapaPedida}" en ${slug}.`);
    console.error(`\nEtapas de ${org.name}:`);
    for (const s of stages) {
      console.error(`  ${s.funnel.padEnd(11)} ${String(s.position).padStart(2)}  ${s.name}`);
    }
    console.error(`\nRepite con --etapa "<nombre>".`);
    process.exit(1);
  }

  let q = sb
    .from("opportunities")
    .select(
      "id, display_reference, contact_id, assigned_advisor_id, actual_amount, estimated_amount, " +
        "shopify_draft_order_id, shopify_order_id, note, created_at, effective_created_at, cancelled_at",
    )
    .eq("organization_id", org.id)
    .eq("stage_id", etapa.id);
  if (!incluirCanceladas) q = q.is("cancelled_at", null);
  const { data: oppRows, error } = await q;
  if (error) throw error;
  type Opp = {
    id: string; display_reference: string | null; contact_id: string | null;
    assigned_advisor_id: string | null; actual_amount: number | null;
    estimated_amount: number | null; shopify_draft_order_id: string | null;
    shopify_order_id: string | null; note: string | null; created_at: string;
    effective_created_at: string | null; cancelled_at: string | null;
  };
  const opps = (oppRows ?? []) as unknown as Opp[];

  if (opps.length === 0) {
    console.log(`"${etapa.name}" no tiene oportunidades${incluirCanceladas ? "" : " activas"}.`);
    return;
  }

  // Contactos, asesores e historial, en lote — nunca una consulta por fila.
  const contactIds = Array.from(new Set(opps.map((o) => o.contact_id).filter(Boolean))) as string[];
  const { data: contactRows } = await sb
    .from("contacts")
    .select("id, full_name, phone, email, last_whaapy_activity_at, shopify_customer_id")
    .in("id", contactIds.length > 0 ? contactIds : ["00000000-0000-0000-0000-000000000000"]);
  const contactos = new Map(
    ((contactRows ?? []) as Array<Record<string, unknown>>).map((c) => [c.id as string, c]),
  );

  const { data: memRows } = await sb
    .from("memberships")
    .select("id, user_id")
    .eq("organization_id", org.id);
  const { data: profRows } = await sb.from("user_profiles").select("id, full_name");
  const perfil = new Map(
    ((profRows ?? []) as Array<{ id: string; full_name: string | null }>).map((p) => [p.id, p.full_name]),
  );
  const asesor = new Map(
    ((memRows ?? []) as Array<{ id: string; user_id: string }>).map((m) => [
      m.id,
      perfil.get(m.user_id) ?? "(sin nombre)",
    ]),
  );

  // Última entrada a ESTA etapa, por oportunidad: es lo que mide cuánto
  // lleva la tarjeta parada aquí.
  const { data: histRows } = await sb
    .from("opportunity_stage_history")
    .select("opportunity_id, effective_event_at, changed_at")
    .eq("organization_id", org.id)
    .eq("to_stage_id", etapa.id)
    .in("opportunity_id", opps.map((o) => o.id));
  const entroEn = new Map<string, string>();
  for (const h of (histRows ?? []) as Array<{
    opportunity_id: string; effective_event_at: string | null; changed_at: string;
  }>) {
    const cuando = h.effective_event_at ?? h.changed_at;
    const prev = entroEn.get(h.opportunity_id);
    if (prev === undefined || cuando > prev) entroEn.set(h.opportunity_id, cuando);
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = "Centr Hub";
  wb.created = new Date();
  const ws = wb.addWorksheet(etapa.name.slice(0, 30));

  ws.columns = [
    { header: "Contacto", key: "contacto", width: 30 },
    { header: "Teléfono", key: "telefono", width: 18 },
    { header: "Email", key: "email", width: 30 },
    { header: "Asesor", key: "asesor", width: 20 },
    { header: "Monto", key: "monto", width: 14 },
    { header: "Días en la etapa", key: "diasEtapa", width: 16 },
    { header: "Entró a la etapa", key: "entro", width: 18 },
    { header: "Días sin actividad en WhatsApp", key: "diasWhatsapp", width: 18 },
    { header: "Cotización", key: "cotizacion", width: 16 },
    { header: "Pedido", key: "pedido", width: 16 },
    { header: "Referencia", key: "referencia", width: 16 },
    { header: "Creada", key: "creada", width: 18 },
    { header: "Nota", key: "nota", width: 40 },
  ];
  if (incluirCanceladas) ws.columns = [...ws.columns, { header: "Cancelada", key: "cancelada", width: 18 }];

  for (const o of opps) {
    const c = (o.contact_id ? contactos.get(o.contact_id) : null) ?? {};
    const monto = o.actual_amount ?? o.estimated_amount ?? null;
    ws.addRow({
      contacto: (c.full_name as string | null) ?? "(sin contacto)",
      // Texto, no número: Excel se come el "+" y los ceros a la izquierda.
      telefono: (c.phone as string | null) ?? "",
      email: (c.email as string | null) ?? "",
      asesor: o.assigned_advisor_id ? asesor.get(o.assigned_advisor_id) ?? "" : "Sin asignar",
      monto: monto === null ? "" : Number(monto),
      diasEtapa: dias(entroEn.get(o.id) ?? null, zona) ?? "",
      entro: fecha(entroEn.get(o.id) ?? null, zona),
      // Vacío se leería como "contestó hoy". No es lo mismo no tener
      // actividad registrada que tenerla reciente.
      diasWhatsapp:
        dias((c.last_whaapy_activity_at as string | null) ?? null, zona) ?? "Sin registro",
      cotizacion: o.shopify_draft_order_id ?? "",
      pedido: o.shopify_order_id ?? "",
      referencia: o.display_reference ?? "",
      creada: fecha(o.effective_created_at ?? o.created_at, zona),
      nota: o.note ?? "",
      cancelada: fecha(o.cancelled_at, zona),
    });
  }

  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = {
    type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" },
  };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };
  ws.getColumn("telefono").numFmt = "@";
  ws.getColumn("monto").numFmt = `#,##0.00 "${moneda}"`;

  // Ordenado por lo que más duele mirar: lo que lleva más tiempo parado.
  const filas = ws.getRows(2, ws.rowCount - 1) ?? [];
  const datos = filas.map((r) => r.values);
  datos.sort((a, b) => {
    const da = Number((a as unknown[])[6]) || 0;
    const db = Number((b as unknown[])[6]) || 0;
    return db - da;
  });
  filas.forEach((r, i) => {
    r.values = datos[i] as ExcelJS.CellValue[];
  });
  ws.getColumn("telefono").numFmt = "@";

  const salida =
    arg("salida") ??
    resolve(process.cwd(), `${slug}-${normalizar(etapa.name).replace(/\s+/g, "-")}.xlsx`);
  await wb.xlsx.writeFile(salida);

  console.log(`${org.name} · etapa "${etapa.name}" (${etapa.funnel})`);
  console.log(`${opps.length} oportunidades${incluirCanceladas ? " (incluye canceladas)" : " activas"}`);
  console.log(`\nArchivo: ${salida}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
