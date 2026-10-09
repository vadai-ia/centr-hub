import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  AUDIT_CATALOG,
  TIMELINE_CATEGORY_LABELS,
  TIMELINE_CATEGORY_ORDER,
  categoryOfKind,
  describeAuditEvent,
} from "@/lib/services/timeline-catalog";

/**
 * Catálogo de la bitácora (punto 24).
 *
 * El acoplamiento que protege: las keys del catálogo son `event_type` del
 * audit log, strings que se escriben en otro archivo. Renombrar el evento en
 * el emisor saca el hecho de la bitácora EN SILENCIO — nada truena, el
 * cliente simplemente parece no tener historia.
 */

const ROOT = path.resolve(__dirname, "..");

describe("describeAuditEvent", () => {
  it("un evento del catálogo trae tipo, categoría y etiqueta en español", () => {
    const d = describeAuditEvent("venta_delivery_message_sent", {});
    expect(d).not.toBeNull();
    expect(d?.kind).toBe("message_sent");
    expect(d?.category).toBe("mensajes");
    expect(d?.label).toMatch(/WhatsApp enviado/);
  });

  it("un evento FUERA del catálogo devuelve null — no entra a la bitácora", () => {
    // Es el 90% del audit log: recibos de webhook, ecos descartados,
    // intentos de sincronización. Si entraran, sepultarían los hechos.
    for (const ruido of [
      "shopify_webhook_received",
      "sync_loop_prevented",
      "whaapy_sync_intent_recorded",
      "inngest_dlq",
    ]) {
      expect(describeAuditEvent(ruido, {})).toBeNull();
    }
  });

  it("nunca devuelve el nombre técnico crudo como etiqueta", () => {
    // El mapeo anterior caía a `return eventType`, así que un evento sin
    // traducir se pintaba como "postventa_whaapy_push_skipped".
    for (const [eventType, entry] of Object.entries(AUDIT_CATALOG)) {
      expect(entry.label({})).not.toBe(eventType);
      expect(entry.label({})).not.toMatch(/_/);
    }
  });

  it("la etiqueta usa el payload cuando aporta el detalle útil", () => {
    expect(
      describeAuditEvent("contact_edited_manually", { fields: ["phone", "email"] })?.label,
    ).toContain("phone, email");
    expect(describeAuditEvent("lead_created", { source: "webhook" })?.label).toContain(
      "formulario web",
    );
    expect(
      describeAuditEvent("venta_delivery_push_skipped", { skip_reason: "missing_phone" })
        ?.label,
    ).toContain("no tiene teléfono");
  });

  it("un payload vacío o con basura no truena ni deja la etiqueta a medias", () => {
    expect(describeAuditEvent("lead_created", {})?.label).toBe("Lead capturado");
    expect(describeAuditEvent("contact_edited_manually", { fields: [] })?.label).toBe(
      "Datos editados",
    );
    expect(
      describeAuditEvent("contact_edited_manually", { fields: "no-es-lista" })?.label,
    ).toBe("Datos editados");
  });

  it("distingue los dos disparadores de la auto-creación", () => {
    const a = describeAuditEvent("c2_opportunity_auto_created", {
      trigger: "new_contact_in_whaapy",
    })?.label;
    const b = describeAuditEvent("c2_opportunity_auto_created", {
      trigger: "reactivity_after_n_days",
    })?.label;
    expect(a).not.toBe(b);
  });
});

describe("categorías", () => {
  it("toda categoría usada en el catálogo tiene etiqueta y lugar en el orden", () => {
    for (const entry of Object.values(AUDIT_CATALOG)) {
      expect(TIMELINE_CATEGORY_LABELS[entry.category]).toBeTruthy();
      expect(TIMELINE_CATEGORY_ORDER).toContain(entry.category);
    }
  });

  it("los eventos que no vienen del audit log también caen en una categoría", () => {
    expect(categoryOfKind("stage_change")).toBe("pipeline");
    expect(categoryOfKind("order_paid")).toBe("cotizacion");
    expect(categoryOfKind("manual_note")).toBe("atencion");
    expect(categoryOfKind("task_created")).toBe("atencion");
  });

  it("cubre las seis categorías que la bitácora ofrece como filtro", () => {
    const usadas = new Set(Object.values(AUDIT_CATALOG).map((e) => e.category));
    // "cotizacion" y "atencion" no vienen del audit log (salen de `orders`,
    // `tasks` y `activities`), así que se cubren vía categoryOfKind.
    for (const c of TIMELINE_CATEGORY_ORDER) {
      const cubierta =
        usadas.has(c) ||
        ["cotizacion", "atencion"].includes(c);
      expect(cubierta, `categoría sin eventos: ${c}`).toBe(true);
    }
  });
});

describe("contrato: los event_type del catálogo los emite alguien", () => {
  /** Todo el código de negocio, para buscar los strings emitidos. */
  function sourceFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(path.resolve(ROOT, dir), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) sourceFiles(rel, acc);
      else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(rel);
    }
    return acc;
  }

  it("ninguna key del catálogo quedó huérfana por un rename", () => {
    // Si alguien renombra el evento en el emisor y no aquí, el hecho
    // desaparece de la bitácora sin un solo error. Este guard lo caza.
    // `scripts` entra: los correctivos de mantenimiento también escriben
    // audits que la bitácora muestra (el envío correctivo de la encuesta, por
    // ejemplo). Dejarlo fuera hacía fallar el guard con un falso positivo.
    const files = [...sourceFiles("lib"), ...sourceFiles("app"), ...sourceFiles("scripts")];
    const blob = files
      .filter((f) => !f.includes("timeline-catalog"))
      .map((f) => readFileSync(path.resolve(ROOT, f), "utf8"))
      .join("\n");
    const sql = readdirSync(path.resolve(ROOT, "supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(path.resolve(ROOT, "supabase/migrations", f), "utf8"))
      .join("\n");
    const todo = blob + sql;

    const huerfanos = Object.keys(AUDIT_CATALOG).filter((k) => !todo.includes(k));
    expect(huerfanos, `event_type en el catálogo que nadie emite: ${huerfanos.join(", ")}`).toEqual([]);
  });
});
