import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { WHAAPY_TOPIC_TO_INNGEST } from "@/lib/inngest/client";

/**
 * Guard estático del tiempo de respuesta (0058).
 *
 * Los tres acoplamientos de aquí fallan EN SILENCIO: nada truena, `tsc`
 * queda contento y la suite mockeada pasa. El síntoma es "la tarjeta dice
 * que nadie escribió", indistinguible de "nadie escribió".
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.resolve(ROOT, rel), "utf8");

const worker = read("lib/inngest/functions/whaapy-messages.ts");
const index = read("lib/inngest/functions/index.ts");
const db = read("lib/db/whaapy-messages.ts");
const metrics = read("lib/services/dashboard-metrics.ts");

describe("el ingreso de mensajes está cableado de punta a punta", () => {
  it("el endpoint acepta los dos topics", () => {
    // Un topic ausente del mapa se descarta con 200 + audit
    // `unhandled_whaapy_event`: el webhook responde bien y no entra nada.
    expect(WHAAPY_TOPIC_TO_INNGEST["message.received"]).toBe(
      "whaapy/message.received",
    );
    expect(WHAAPY_TOPIC_TO_INNGEST["message.sent"]).toBe("whaapy/message.sent");
  });

  it("los workers están registrados en allFunctions", () => {
    // Sin esto Inngest no sirve la función: el evento se encola y nadie lo
    // atiende.
    expect(index).toContain("whaapyMessageFunctions");
    expect(index).toContain("...whaapyMessageFunctions,");
  });

  it("los workers consumen exactamente esos eventos", () => {
    expect(worker).toContain('event: "whaapy/message.received"');
    expect(worker).toContain('event: "whaapy/message.sent"');
  });
});

describe("no se guarda el contenido del mensaje", () => {
  const migracion = (() => {
    const dir = path.resolve(ROOT, "supabase/migrations");
    const f = readdirSync(dir).find((n) => n.startsWith("0058_"));
    if (!f) throw new Error("falta la migración 0058");
    return readFileSync(path.join(dir, f), "utf8");
  })();

  it("la tabla no tiene columna de texto del mensaje", () => {
    // La métrica necesita CUÁNDO y EN QUÉ SENTIDO. El texto sería PII en una
    // tabla nueva sin ninguna lectura que la justifique.
    const tabla = migracion.slice(
      migracion.indexOf("create table if not exists public.whaapy_messages"),
      migracion.indexOf(");", migracion.indexOf("create table")),
    );
    expect(tabla).not.toMatch(/\bbody\b|\bcontent\b|\btext_body\b|\bmessage_text\b/);
  });

  it("el worker tampoco lo persiste", () => {
    const insert = worker.slice(worker.indexOf("recordWhaapyMessage({"));
    expect(insert).not.toContain("content");
    expect(insert).not.toContain("body");
  });
});

describe("las decisiones que hacen que el número signifique algo", () => {
  it("el bot se distingue del humano", () => {
    // Sin `sent_by_ai` todos los asesores marcarían respuesta instantánea:
    // el agente de IA de Whaapy contesta en segundos.
    expect(worker).toContain("sent_by_ai");
    expect(db).toContain("sent_by_ai");
    const puro = read("lib/services/response-times.ts");
    expect(puro).toContain("if (m.sentByAi) continue;");
  });

  it("el asesor se CONGELA al ingestar, no se resuelve al consultar", () => {
    // La asignación del contacto cambia de dueño; resolverla por join al
    // leer reportaría las respuestas de ayer a cargo del asesor de hoy.
    expect(worker).toContain("assigned_advisor_id");
    expect(db).toContain("advisor_membership_id: input.advisorMembershipId");
  });

  it("la lectura está PAGINADA", () => {
    // PostgREST corta en 1000 filas sin error. Una organización con tráfico
    // de WhatsApp pasa de eso en días: la mediana saldría de una muestra
    // arbitraria y los números se verían plausibles.
    expect(db).toContain("fetchAllPaged");
  });

  it("un vendedor no ve los tiempos de toda la organización", () => {
    // Misma regla que el resto de lecturas alcanzables por vendedor: el
    // scope se aplica en la capa de datos, no ocultando en la UI.
    expect(metrics).toContain("computeResponseTimes({");
    const llamada = metrics.slice(
      metrics.indexOf("computeResponseTimes({"),
      metrics.indexOf("});", metrics.indexOf("computeResponseTimes({")),
    );
    expect(llamada).toContain("scope,");
  });

  it("la lectura trae margen hacia atrás del periodo", () => {
    // Una respuesta del día 1 a una pregunta del 31 aparecería, sin margen,
    // como respuesta sin pregunta y se descartaría en silencio.
    expect(metrics).toContain("RESPONSE_WINDOW_LOOKBACK_DAYS");
    expect(metrics).toContain("messageWindowStart");
  });

  it("la tarjeta declara desde cuándo mide", () => {
    // La tabla arranca vacía el día del despliegue y no hay forma de
    // reconstruir hacia atrás: un periodo anterior se leería como "nadie
    // escribió" en vez de "no se medía".
    expect(db).toContain("getFirstMessageAt");
    expect(metrics).toContain("messagesSince");
    const card = read("app/(dashboard)/dashboard/dashboard-response-times.tsx");
    expect(card).toContain("measuringSince");
  });
});
