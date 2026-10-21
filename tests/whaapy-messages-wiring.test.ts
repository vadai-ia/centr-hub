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

  it("un message.sent SIN autoría no se guarda", () => {
    // Capturado en producción: Whaapy emite `message.sent` DOS veces con el
    // MISMO message_id — el payload completo y una actualización de estado
    // sin `sent_by_ai`. El índice único deduplica y gana el primero; si
    // ganara el de estado, el mensaje quedaría como HUMANO por defecto y un
    // mensaje del bot contaría como respuesta del asesor.
    expect(worker).toContain("status_update_without_authorship");
    expect(worker).toMatch(/data.sent_by_ai === null || data.sent_by_ai === undefined/);
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

describe("los acuses de entrega no llenan la campanita", () => {
  const endpoint = read("app/api/webhooks/whaapy/route.ts");
  const client = read("lib/inngest/client.ts");

  it("message.delivered / read / failed se ignoran SIN avisar al admin", () => {
    // Llegan por el mismo webhook que suscribimos para medir el tiempo de
    // respuesta. Tratarlos como "evento nuevo de Whaapy que hay que revisar"
    // generaba dos avisos por cada mensaje enviado — medido: 112 avisos.
    for (const t of ["message.delivered", "message.read", "message.failed"]) {
      expect(client).toContain(`"${t}"`);
    }
    expect(endpoint).toContain("WHAAPY_IGNORED_TOPICS.has(topic)");
    const bloque = endpoint.slice(
      endpoint.indexOf("if (WHAAPY_IGNORED_TOPICS.has(topic))"),
      endpoint.indexOf("await handleUnhandledEvent"),
    );
    // El camino de ignorados NO puede pasar por el notificador.
    expect(bloque).not.toContain("handleUnhandledEvent");
    expect(bloque).toContain("ignored_topic");
  });

  it("un topic DESCONOCIDO sigue avisando", () => {
    // La lista es de ignorados explícitos, no un silenciador general: si
    // Whaapy agrega un evento nuevo, hay que enterarse.
    expect(endpoint).toContain("await handleUnhandledEvent(org.id, topic, deliveryId);");
  });
});

describe("una organización sin Whaapy no genera alertas", () => {
  const outbound = read("lib/inngest/functions/whaapy-outbound.ts");

  it("el envío saliente se SALTA en vez de fallar", () => {
    // "Sin configurar" es una decisión, no una avería: hay organizaciones
    // que usan Shopify y no Whaapy. Dejar que reviente lo mandaba a
    // reintentos y de ahí a una alerta por algo que ningún reintento
    // arregla — medido: 678 avisos idénticos en Centr Colombia.
    expect(outbound).toContain("hasWhaapyApiKey");
    expect(outbound).toContain("whaapy_outbound_skipped_not_connected");
    expect(outbound).toContain('reason: "whaapy_not_connected"');
  });

  it("el chequeo NO lanza", () => {
    const vault = read("lib/vault/index.ts");
    const fn = vault.slice(
      vault.indexOf("export async function hasWhaapyApiKey"),
      vault.indexOf("export async function storeWhaapyApiKey"),
    );
    expect(fn).not.toContain("throw");
  });
});

describe("un mismo fallo no se anuncia dos veces", () => {
  const dlq = read("lib/inngest/functions/dlq.ts");

  it("como máximo UN aviso abierto por función y organización", () => {
    // El audit registra SIEMPRE cada fallo; la campanita recibe uno solo.
    // Cientos de avisos idénticos sepultan los recordatorios de tareas.
    expect(dlq).toContain('.eq("origin_reference->>function_id", functionId)');
    expect(dlq).toContain('.eq("status", "pending")');
    expect(dlq).toContain("if (abierto && abierto.length > 0) continue;");
  });

  it("el audit se escribe SIEMPRE, antes de decidir si notifica", () => {
    expect(dlq.indexOf('eventType: "inngest_dlq"')).toBeLessThan(
      dlq.indexOf("if (abierto && abierto.length > 0) continue;"),
    );
  });
});
