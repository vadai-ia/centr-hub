import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { loadInitialContactsState } from "@/lib/actions/contacts";
import { ContactsBoard } from "./contacts-board";

/**
 * Pestaña Contactos (M6 — B2).
 *
 * Server Component que pide el snapshot inicial vía Server Action
 * y delega la interactividad (búsqueda con debounce, paginación) al
 * Client `ContactsBoard`. Patrón espejo de `pipeline/page.tsx`.
 */
export default async function ContactosPage() {
  const session = await getSession();
  if (session.status !== "ok") {
    redirect("/login");
  }

  const initial = await loadInitialContactsState({});
  if (!initial.ok) {
    return (
      <div className="text-center py-16 text-gray-500 dark:text-gray-400">
        <p className="text-base font-medium text-gray-700 dark:text-gray-200">
          No se pudo cargar Contactos
        </p>
        <p className="mt-2 text-sm">{initial.message}</p>
      </div>
    );
  }

  return (
    <ContactsBoard
      key={session.data.activeOrg.id}
      initial={initial.state}
    />
  );
}
