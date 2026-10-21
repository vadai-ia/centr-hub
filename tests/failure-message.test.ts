import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describeSystemFailure } from "@/lib/services/failure-message";
import {
  filterByAge,
  NOTIFICATION_AGE_DEFAULT,
} from "@/lib/services/notification-filter";

/**
 * El aviso de un fallo lo lee quien NO lo va a arreglar. Un volcado de
 * Postgres no le dice qué pasó, ni si tiene que hacer algo, ni a quién
 * avisar — solo le enseña a cerrar avisos sin leerlos.
 */

const CASOS = [
  {
    nombre: "duplicado de Postgres",
    functionId: "centr-hub-whaapy-outbound-contact-sync",
    errorMessage:
      '{"code":"23505","details":"Key (organization_id, whaapy_contact_id)=(a1e, 7b8) already exists.","hint":null,"message":"duplicate key value violates unique constraint \\"contacts_org_whaapy_contact_unique\\""}',
  },
  {
    nombre: "credencial ausente",
    functionId: "centr-hub-whaapy-outbound-contact-sync",
    errorMessage:
      "vault_missing_credential: whaapy.api_key no configurada para la organización a18a4437.",
  },
  {
    nombre: "sin permiso",
    functionId: "centr-hub-shopify-orders-updated",
    errorMessage: "Shopify respondió 401 Unauthorized",
  },
  {
    nombre: "servicio caído",
    functionId: "centr-hub-shopify-customers-create",
    errorMessage: "ETIMEDOUT",
  },
  {
    nombre: "error desconocido",
    functionId: "centr-hub-venta-delivery-message-push",
    errorMessage: "TypeError: Cannot read properties of undefined (reading 'id')",
  },
];

describe("ningún aviso muestra jerga técnica", () => {
  for (const c of CASOS) {
    it(c.nombre, () => {
      const { title, message } = describeSystemFailure(c);
      const texto = `${title} ${message}`;
      // Nada de códigos, nombres de tabla/columna/función ni volcados.
      for (const prohibido of [
        "23505",
        "duplicate key",
        "unique constraint",
        "organization_id",
        "whaapy_contact_id",
        "vault_missing_credential",
        "centr-hub-",
        "Inngest",
        "TypeError",
        "ETIMEDOUT",
        "401",
        "{",
      ]) {
        expect(texto, `"${prohibido}" no debería salir en pantalla`).not.toContain(
          prohibido,
        );
      }
      expect(title.length).toBeGreaterThan(0);
      expect(message.length).toBeGreaterThan(20);
    });
  }

  it("el duplicado dice que no hay nada que hacer", () => {
    // Es el caso más común y el más inofensivo: el dato ya estaba.
    const { message } = describeSystemFailure(CASOS[0]!);
    expect(message).toContain("no hay nada que hacer");
  });

  it("la credencial ausente dice DÓNDE se arregla", () => {
    // Este sí lo resuelve quien lee, y en un sitio concreto.
    const { message } = describeSystemFailure(CASOS[1]!);
    expect(message).toContain("Integraciones");
  });

  it("nombra el sistema en palabras del negocio", () => {
    expect(describeSystemFailure(CASOS[1]!).title).toContain("WhatsApp");
    expect(describeSystemFailure(CASOS[2]!).title).toContain("Shopify");
  });
});

describe("el detalle técnico no se pierde", () => {
  it("sigue yendo al registro de origen", () => {
    const dlq = readFileSync(
      path.resolve(__dirname, "..", "lib/inngest/functions/dlq.ts"),
      "utf8",
    );
    // En `origin_reference` y en el audit: es donde se diagnostica.
    expect(dlq).toContain("error: errorMessage");
    expect(dlq).toContain("error_message: errorMessage");
    // Pero NO en lo que se pinta.
    expect(dlq).toContain("title: copy.title");
    expect(dlq).toContain("message: copy.message");
  });
});

describe("filtro por antigüedad", () => {
  // Fechas construidas en hora LOCAL: "hoy" es el día de quien mira la
  // pantalla, así que una prueba con horas UTC pasaría o fallaría según la
  // zona de la máquina que la corre.
  const local = (y: number, m: number, d: number, h: number) =>
    new Date(y, m - 1, d, h, 0, 0);
  const ahora = local(2026, 10, 21, 9);
  const item = (fecha: Date) => ({ createdAt: fecha.toISOString() });

  it("el default NO esconde nada", () => {
    // Un pendiente es trabajo sin hacer: que la pantalla lo oculte sola,
    // por viejo, es como se pierde una tarea.
    expect(NOTIFICATION_AGE_DEFAULT).toBe("all");
  });

  it('"Hoy" es el día civil, no las últimas 24 h', () => {
    const ayerTarde = item(local(2026, 10, 20, 20));
    const hoyTemprano = item(local(2026, 10, 21, 1));
    const r = filterByAge([ayerTarde, hoyTemprano], "today", ahora);
    expect(r).toHaveLength(1);
    expect(r[0]).toBe(hoyTemprano);
  });

  it("acota por días", () => {
    const items = [
      item(local(2026, 10, 20, 10)),
      item(local(2026, 10, 1, 10)),
      item(local(2026, 8, 1, 10)),
    ];
    expect(filterByAge(items, "7d", ahora)).toHaveLength(1);
    expect(filterByAge(items, "30d", ahora)).toHaveLength(2);
    expect(filterByAge(items, "all", ahora)).toHaveLength(3);
  });

  it("una fecha ilegible NO se oculta", () => {
    // Esconder un pendiente por un dato sucio es peor que mostrarlo de más.
    expect(filterByAge([{ createdAt: "vaya fecha" }], "7d", ahora)).toHaveLength(1);
  });
});
