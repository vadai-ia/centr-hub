import { loadInboundWebhookSources } from "@/lib/actions/admin-lead-webhooks";
import { WebhooksScreen } from "./webhooks-screen";

/**
 * Admin → Webhooks de leads (0038, Bloque B). Gestión de fuentes externas
 * que crean leads por webhook: crear/revocar/rotar, cada una con su endpoint
 * y credencial propios.
 */
export default async function WebhooksPage() {
  const res = await loadInboundWebhookSources();
  if (!res.ok) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center text-gray-500 dark:text-gray-400">
        <p>{res.message}</p>
      </div>
    );
  }
  return <WebhooksScreen initialSources={res.sources} />;
}
