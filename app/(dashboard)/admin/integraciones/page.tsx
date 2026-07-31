import { requireTabOrRedirect } from "@/lib/auth/require-tab";
import { loadIntegrationsAction } from "@/lib/actions/admin-integrations";
import { IntegracionesScreen } from "./integraciones-screen";

/**
 * Admin → Integraciones (0046). Conectar, cambiar, probar y desconectar las
 * tres conexiones externas —Shopify, Whaapy Venta y Whaapy Post-venta— sin
 * tocar código, variables de entorno ni SQL.
 *
 * Las credenciales NUNCA viajan al cliente: esta página recibe solo estado,
 * últimos 4 dígitos y resultados de prueba.
 */
export default async function IntegracionesPage() {
  await requireTabOrRedirect("admin-integraciones");
  const res = await loadIntegrationsAction();
  if (!res.ok) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center text-gray-500 dark:text-gray-400">
        <p>{res.message}</p>
      </div>
    );
  }
  return <IntegracionesScreen initialCards={res.cards} />;
}
