import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { notificationTarget, taskIdOf } from "@/lib/services/notification-target";
import type { UUID } from "@/lib/types/database";

/**
 * A dónde lleva un aviso al tocarlo.
 *
 * Lo consumen TRES sitios —campanita, emergentes y el panel de Mi Día—; si
 * cada uno resolviera su destino, el mismo aviso llevaría a sitios distintos
 * según dónde se tocara.
 */

const OPP = "11111111-1111-1111-1111-111111111111" as UUID;
const CONTACTO = "22222222-2222-2222-2222-222222222222" as UUID;

describe("destino de un aviso", () => {
  it("la OPORTUNIDAD manda sobre el contacto", () => {
    // Un aviso de "oportunidad estancada" trae los dos, y lo accionable es
    // la tarjeta: en el contacto habría que volver a buscar de cuál de sus
    // oportunidades habla.
    const t = notificationTarget({
      opportunityId: OPP,
      contactId: CONTACTO,
      originReference: null,
    });
    expect(t?.href).toBe(`/pipeline?opp=${OPP}`);
  });

  it("solo contacto lleva a su ficha", () => {
    const t = notificationTarget({
      opportunityId: null,
      contactId: CONTACTO,
      originReference: null,
    });
    expect(t?.href).toBe(`/contactos/${CONTACTO}`);
  });

  it("un recordatorio de TAREA lleva a Mi Día", () => {
    // El id de la tarea viaja en `origin_reference`, no en una columna. Sin
    // este caso, el aviso más frecuente del sistema sería justo el único que
    // no lleva a ninguna parte.
    const t = notificationTarget({
      opportunityId: null,
      contactId: null,
      originReference: { task_id: "abc" },
    });
    expect(t?.href).toBe("/mi-dia");
  });

  it("sin nada a dónde ir devuelve null, no una ruta inventada", () => {
    expect(
      notificationTarget({ opportunityId: null, contactId: null, originReference: null }),
    ).toBeNull();
    expect(
      notificationTarget({
        opportunityId: null,
        contactId: null,
        originReference: { function_id: "x" },
      }),
    ).toBeNull();
  });

  it("aguanta un origin_reference con basura", () => {
    // Es una columna jsonb: puede traer cualquier cosa de versiones viejas.
    for (const ref of [[], "texto", 3, { task_id: 7 }, { task_id: "" }] as never[]) {
      expect(taskIdOf({ originReference: ref })).toBeNull();
    }
  });
});

describe("los tres sitios usan la MISMA resolución", () => {
  const read = (rel: string) =>
    readFileSync(path.resolve(__dirname, "..", rel), "utf8");

  it("campanita, emergentes y Mi Día", () => {
    for (const f of [
      "components/ui/notifications-bell.tsx",
      "components/ui/notification-toasts.tsx",
      "app/(dashboard)/mi-dia/mi-dia-notifications.tsx",
    ]) {
      expect(read(f), `${f} debe resolver el destino con notificationTarget`).toContain(
        "notificationTarget",
      );
    }
  });

  it("ninguno arma la ruta a mano", () => {
    // Un `/pipeline?opp=` escrito a mano es el camino por el que los tres
    // vuelven a divergir.
    for (const f of [
      "components/ui/notification-toasts.tsx",
      "app/(dashboard)/mi-dia/mi-dia-notifications.tsx",
    ]) {
      expect(read(f)).not.toContain("/pipeline?opp=");
    }
  });

  it("descartar no abre el aviso", () => {
    // La fila entera es clicable: sin detener la propagación, la ✕ abre lo
    // que acaba de descartar.
    const bell = read("components/ui/notifications-bell.tsx");
    const cerrar = bell.slice(bell.indexOf('aria-label="Descartar"') - 400, bell.indexOf('aria-label="Descartar"'));
    expect(cerrar).toContain("e.stopPropagation()");
  });
});
