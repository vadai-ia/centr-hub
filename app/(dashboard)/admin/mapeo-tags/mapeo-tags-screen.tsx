"use client";
import { useMemo, useState } from "react";
import { reprocessTagAction } from "@/lib/actions/admin-tags";
import type { TagMappingView, TagVendorOption } from "@/lib/types/admin";
import { TagReclassifyModal } from "./tag-reclassify-modal";

interface Props {
  initialMappings: TagMappingView[];
  vendors: TagVendorOption[];
}

type Filter = "all" | "vendor" | "informational";

/**
 * Pantalla admin de Mapeo de tags (M7.2, Bloque 5). Listado de tags
 * detectadas con conteo + clasificación, filtros, reclasificación y
 * re-procesamiento retroactivo de la atribución.
 */
export function MapeoTagsScreen({ initialMappings, vendors }: Props) {
  const [mappings, setMappings] = useState(initialMappings);
  const [filter, setFilter] = useState<Filter>("all");
  const [busyTag, setBusyTag] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ tone: "error" | "success" | "info"; text: string } | null>(null);
  const [modalTag, setModalTag] = useState<TagMappingView | null>(null);

  const visible = useMemo(() => {
    if (filter === "all") return mappings;
    return mappings.filter((m) => m.classification === filter);
  }, [mappings, filter]);

  async function reprocess(tag: TagMappingView) {
    setBusyTag(tag.normalized);
    const res = await reprocessTagAction({
      normalizedTag: tag.normalized,
      originalTag: tag.original,
      membershipId: tag.mapped_membership_id,
    });
    setBusyTag(null);
    if (!res.ok) {
      setBanner({ tone: "error", text: res.message });
      return;
    }
    if (res.mode === "none") {
      setBanner({ tone: "info", text: "Sin entidades pendientes para esta tag." });
    } else if (res.mode === "background") {
      setBanner({
        tone: "info",
        text: `Re-procesando ${res.count} entidades en segundo plano. Te avisaremos al terminar.`,
      });
    } else {
      setBanner({
        tone: "success",
        text: `Re-atribuidas ${res.count} entidad${res.count === 1 ? "" : "es"}.`,
      });
    }
  }

  return (
    <div className="max-w-3xl mx-auto">
      <header className="mb-4">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Mapeo de tags</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
          Clasifica cada tag de Shopify como de vendedor (atribuye al asesor) o informativa. Las
          informativas no asignan a nadie.
        </p>
      </header>

      <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 p-0.5 mb-4">
        <FilterTab active={filter === "vendor"} onClick={() => setFilter("vendor")}>
          De vendedor
        </FilterTab>
        <FilterTab active={filter === "informational"} onClick={() => setFilter("informational")}>
          Informativa
        </FilterTab>
        <FilterTab active={filter === "all"} onClick={() => setFilter("all")}>
          Todas
        </FilterTab>
      </div>

      {banner && (
        <div
          role={banner.tone === "error" ? "alert" : "status"}
          className={`mb-3 px-3 py-2 rounded-md text-sm flex items-center justify-between gap-3 ${
            banner.tone === "error"
              ? "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300"
              : banner.tone === "success"
                ? "bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300"
                : "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
          }`}
        >
          <span>{banner.text}</span>
          <button type="button" onClick={() => setBanner(null)} className="text-xs underline opacity-80 hover:opacity-100">
            cerrar
          </button>
        </div>
      )}

      {visible.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 py-8 text-center">
          No hay tags {filter === "vendor" ? "de vendedor" : filter === "informational" ? "informativas" : "detectadas"}.
        </p>
      ) : (
        <ul className="space-y-2">
          {visible.map((tag) => (
            <li
              key={tag.normalized}
              className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{tag.original}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {tag.count} entidad{tag.count === 1 ? "" : "es"}
                  {tag.classification === "vendor" && tag.mapped_vendor_name && (
                    <>
                      {" · "}
                      <span className="text-gray-700 dark:text-gray-300">{tag.mapped_vendor_name}</span>
                      {tag.mapped_vendor_active === false && (
                        <span className="ml-1 text-amber-600 dark:text-amber-400">— mapeo inactivo</span>
                      )}
                    </>
                  )}
                </p>
              </div>

              {tag.classification === "vendor" ? (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
                  De vendedor
                </span>
              ) : (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                  Informativa
                </span>
              )}

              {tag.classification === "vendor" && (
                <button
                  type="button"
                  onClick={() => reprocess(tag)}
                  disabled={busyTag === tag.normalized}
                  className="px-2 py-1 text-xs rounded-md border border-indigo-200 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 disabled:opacity-50"
                >
                  {busyTag === tag.normalized ? "..." : "Re-procesar"}
                </button>
              )}
              <button
                type="button"
                onClick={() => setModalTag(tag)}
                disabled={busyTag === tag.normalized}
                className="px-2 py-1 text-xs rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
              >
                {tag.classification === "vendor" ? "Cambiar" : "Reclasificar"}
              </button>
            </li>
          ))}
        </ul>
      )}

      <TagReclassifyModal
        open={modalTag !== null}
        tag={modalTag}
        vendors={vendors}
        onClose={() => setModalTag(null)}
        onSaved={(next) => {
          setMappings(next);
          setModalTag(null);
          setBanner({ tone: "success", text: "Clasificación actualizada. Usa “Re-procesar” para aplicar la atribución a entidades existentes." });
        }}
      />
    </div>
  );
}

function FilterTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
        active
          ? "bg-indigo-600 text-white"
          : "text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
      }`}
    >
      {children}
    </button>
  );
}
