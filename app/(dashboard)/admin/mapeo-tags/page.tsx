import { loadAdminTagMappings } from "@/lib/actions/admin-tags";
import { MapeoTagsScreen } from "./mapeo-tags-screen";

/**
 * Admin → Mapeo de tags ↔ vendedor (M7.2, Bloque 5).
 */
export default async function MapeoTagsPage() {
  const res = await loadAdminTagMappings();
  if (!res.ok) {
    return (
      <div className="max-w-3xl mx-auto py-16 text-center text-gray-500 dark:text-gray-400">
        <p>{res.message}</p>
      </div>
    );
  }
  return <MapeoTagsScreen initialMappings={res.mappings} vendors={res.vendors} />;
}
