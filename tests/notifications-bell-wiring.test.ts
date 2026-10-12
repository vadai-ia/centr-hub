import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Campanita de avisos — guard estático del cableado.
 *
 * Los fallos que protege son silenciosos: nada truena, la campanita
 * simplemente deja de verse o empieza a mostrar un conteo distinto al de
 * otra campanita en la misma pantalla.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.resolve(ROOT, rel), "utf8");

describe("la campanita vive en el navbar, junto al nombre de usuario", () => {
  it("el navbar la monta", () => {
    const navbar = read("components/ui/navbar.tsx");
    expect(navbar).toContain("NotificationsBell");
    expect(navbar).toContain("./notifications-bell");
  });

  it("hay UNA sola: Mi Día ya no tiene la suya", () => {
    // Dos campanitas con dos fuentes de datos acaban mostrando conteos
    // distintos en la misma pantalla, y el usuario no sabe cuál creerle.
    expect(existsSync(path.resolve(ROOT, "app/(dashboard)/mi-dia/mi-dia-bell.tsx"))).toBe(
      false,
    );
    expect(read("app/(dashboard)/mi-dia/mi-dia-screen.tsx")).not.toContain("MiDiaBell");
  });

  it("solo consulta con la pestaña visible", () => {
    // Vive en todas las pantallas: una pestaña olvidada en segundo plano no
    // tiene por qué seguir pidiendo avisos cada minuto.
    const bell = read("components/ui/notifications-bell.tsx");
    expect(bell).toContain("document.hidden");
    expect(bell).toContain("visibilitychange");
  });
});

describe("avisos emergentes en todas las vistas", () => {
  const bell = read("components/ui/notifications-bell.tsx");

  it("salen de la MISMA consulta que la campanita", () => {
    // Dos consultas en paralelo acabarían discrepando, y un emergente que
    // anuncia algo que la campanita no muestra es peor que no tenerlos.
    expect(bell).toContain("NotificationToasts");
    expect(bell).toContain("loadMyNotificationsAction");
    // No hay un segundo componente que consulte por su cuenta.
    expect(read("components/ui/notification-toasts.tsx")).not.toContain(
      "loadMyNotificationsAction",
    );
  });

  it("la PRIMERA consulta no hace emerger lo acumulado", () => {
    // Entrar por la mañana con cinco recordatorios pendientes taparía la
    // pantalla entera. Lo viejo va a la campanita; solo emerge lo nuevo.
    expect(bell).toContain("anunciados");
    expect(bell).toMatch(/anunciados.current === null/);
  });

  it("cerrar el emergente NO descarta el aviso", () => {
    // "Ya lo vi" no es "ya lo atendí": el pendiente sigue en la campanita.
    const toasts = read("components/ui/notification-toasts.tsx");
    expect(toasts).not.toContain("dismissNotificationAction");
  });

  it("el contenedor de emergentes no bloquea clicks de lo que hay debajo", () => {
    // Ocupa una esquina entera de la pantalla; sin esto se traga los clicks
    // aunque esté vacío.
    expect(read("components/ui/notification-toasts.tsx")).toContain(
      "pointer-events-none",
    );
  });
});

describe("los avisos son de QUIEN mira", () => {
  it("la action no recibe parámetros: el usuario sale de la sesión", () => {
    const action = read("lib/actions/notifications.ts");
    expect(action).toMatch(/export async function loadMyNotificationsAction\(\s*\)/);
    expect(action).toContain("session.data.userId");
  });

  it("un fallo de lectura no tumba el navbar", () => {
    // La campanita se pinta en TODAS las pantallas: si su lectura lanza, se
    // lleva por delante la aplicación entera.
    expect(read("lib/actions/notifications.ts")).toContain("catch");
  });
});
