"use server";
import { getSession } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/tenant/context";
import { listNotificationsForUser } from "@/lib/db/operational";
import type { MiDiaBellItem } from "@/lib/services/mi-dia";

/**
 * Avisos pendientes de QUIEN mira, para la campanita del navbar.
 *
 * Lectura propia y mínima en vez de reusar `loadMiDiaAction`: ese arma el
 * tablero entero (tareas, tarjetas, clientes callados, histograma de la
 * semana). La campanita vive en TODAS las pantallas y se refresca sola, así
 * que pagar el bundle de Mi Día en cada tick sería caro y además ataría el
 * navbar a una pantalla concreta.
 *
 * El `userId` sale de la sesión, nunca del cliente: nadie puede pedir los
 * avisos de otra persona.
 */
export type MyNotificationsResult =
  | { ok: true; items: MiDiaBellItem[] }
  | { ok: false };

export async function loadMyNotificationsAction(): Promise<MyNotificationsResult> {
  const session = await getSession();
  if (session.status !== "ok") return { ok: false };
  const orgId = session.data.activeOrg.id;
  const userId = session.data.userId;

  try {
    const rows = await withTenantContext(
      orgId,
      () => listNotificationsForUser(userId),
      { source: "user_session" },
    );
    const items: MiDiaBellItem[] = rows
      .filter((n) => n.status === "pending")
      .map((n) => ({
        id: n.id,
        title: n.title,
        message: n.message,
        notificationType: n.notification_type,
        origin: n.origin,
        isAlert: n.notification_type === "alert",
        createdAt: n.created_at,
        opportunityId: n.opportunity_id,
        contactId: n.contact_id,
        status: n.status,
      }))
      .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));
    return { ok: true, items };
  } catch {
    // La campanita no puede tumbar el navbar: si la lectura falla, se queda
    // con lo que ya tenía y lo reintenta en el siguiente tick.
    return { ok: false };
  }
}
