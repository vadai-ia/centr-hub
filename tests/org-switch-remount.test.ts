import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

/**
 * Guard del cambio de organización sin recargar la página.
 *
 * El acoplamiento que protege es invisible para `tsc`: cada pantalla siembra
 * su estado desde props del servidor con `useState(initial…)`, que SOLO se
 * lee al montar. `router.refresh()` re-renderiza el servidor y baja props de
 * la organización nueva, pero ese `useState` los descarta — la vista se queda
 * con los datos de la organización anterior hasta un refresh manual.
 *
 * Lo que lo arregla es el `key` por organización en el layout: al cambiar,
 * React desmonta y remonta el contenido, y todo re-siembra. Si alguien quita
 * ese `key` "porque no hace nada visible", el bug vuelve EN SILENCIO — no hay
 * error, solo datos de otra organización en pantalla.
 */
describe("cambio de organización sin recargar", () => {
  const layout = readFileSync(
    path.resolve(ROOT, "app", "(dashboard)", "layout.tsx"),
    "utf8",
  );

  it("el contenedor del contenido está keyed por la organización activa", () => {
    const normalized = layout.replace(/\s+/g, " ");
    expect(
      normalized.includes("key={data.activeOrg.id}"),
      "sin este key las pantallas conservan el estado sembrado con la org anterior",
    ).toBe(true);
  });

  it("el key envuelve a {children}, no a un hermano", () => {
    // El key tiene que estar en el elemento que CONTIENE la pantalla; en un
    // hermano (navbar, sidebar) no remonta nada de lo que importa.
    const mainStart = layout.indexOf("<main");
    const mainEnd = layout.indexOf("</main>");
    expect(mainStart).toBeGreaterThan(-1);
    const mainBlock = layout.slice(mainStart, mainEnd);
    expect(mainBlock).toContain("key={data.activeOrg.id}");
    expect(mainBlock).toContain("{children}");
  });

  it("el selector espera a que el refresh termine antes de rehabilitarse", () => {
    const selector = readFileSync(
      path.resolve(ROOT, "components", "ui", "org-selector.tsx"),
      "utf8",
    );
    // `router.refresh()` es asíncrono y devuelve void: fuera de una
    // transición no hay señal de cuándo terminó, y el select se rehabilita
    // mientras la pantalla todavía muestra la organización anterior.
    expect(selector).toContain("useTransition");
    expect(selector.replace(/\s+/g, " ")).toContain(
      "startTransition(() => router.refresh())",
    );
  });
});
