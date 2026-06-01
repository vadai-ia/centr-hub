import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { loadContactDetail } from "@/lib/actions/contacts";
import { ContactDetailScreen } from "./contact-detail-screen";

interface PageProps {
  params: { id: string };
}

/**
 * Detalle de contacto (M6 — B3).
 *
 * Server Component:
 *   - Verifica sesión (layout ya lo hace, pero re-validamos).
 *   - Carga detalle + timeline + advisors vía Server Action.
 *   - 404 si el contact no existe / no tiene acceso. Para `forbidden`
 *     (vendedor accediendo a contact no asignado) usamos notFound()
 *     para no leak de existencia.
 *
 * El Client wrapper `ContactDetailScreen` maneja sub-componentes y
 * estado local del popup de oportunidad (cuando B4 se conecte).
 */
export default async function ContactDetailPage({ params }: PageProps) {
  const session = await getSession();
  if (session.status !== "ok") {
    redirect("/login");
  }

  // Validación rápida del shape del UUID — Next nos lo entrega como
  // string; el data layer falla con 500 si no es UUID válido. Mejor
  // un 404 desde aquí.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    params.id,
  )) {
    notFound();
  }

  const result = await loadContactDetail({ contactId: params.id });
  if (!result.ok) {
    if (result.reason === "not_found" || result.reason === "forbidden") {
      notFound();
    }
    return (
      <div className="text-center py-16 text-gray-500 dark:text-gray-400">
        <p className="text-base font-medium text-gray-700 dark:text-gray-200">
          No se pudo cargar el contacto
        </p>
        <p className="mt-2 text-sm">{result.message}</p>
      </div>
    );
  }

  return <ContactDetailScreen bundle={result.bundle} />;
}
