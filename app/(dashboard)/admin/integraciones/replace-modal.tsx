"use client";
import { useState } from "react";
import type { IntegrationCardView, ReplacePreview } from "@/lib/actions/admin-integrations";

interface Props {
  card: IntegrationCardView;
  preview: ReplacePreview;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: { newDiscriminator: string; storeUrl: string | null; confirmation: string }) => void;
}

/**
 * Reemplazo de conexión — el flujo destructivo, con dry-run explícito.
 *
 * Muestra los conteos REALES antes de tocar nada (vienen de la misma función
 * SQL que ejecuta el desenlace, así que lo listado es lo que va a pasar) y
 * exige teclear una palabra de confirmación, revalidada también en el servidor.
 *
 * Lo que NO se pierde se dice explícitamente: sin esa frase, "desenlazar
 * 4.000 contactos" se lee como "borrar 4.000 contactos".
 */
export function ReplaceModal({ card, preview, busy, onCancel, onSubmit }: Props) {
  const [newDiscriminator, setNewDiscriminator] = useState("");
  const [storeUrl, setStoreUrl] = useState("");
  const [confirmation, setConfirmation] = useState("");

  const confirmed =
    confirmation.trim().toLowerCase() === preview.confirmationWord.toLowerCase();
  const canSubmit =
    !busy && confirmed && newDiscriminator.trim().length > 0 &&
    newDiscriminator.trim() !== preview.currentDiscriminator;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-gray-900/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={busy ? undefined : onCancel}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSubmit) return;
          onSubmit({
            newDiscriminator: newDiscriminator.trim(),
            storeUrl: storeUrl.trim() || null,
            confirmation,
          });
        }}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-lg w-full p-6 max-h-[90vh] overflow-y-auto"
      >
        <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Reemplazar {card.label}
        </p>
        <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
          Apuntar a un sistema externo DISTINTO. Úsalo solo si de verdad cambió la tienda o la
          instancia; para rotar una credencial del mismo sistema usa “Capturar credenciales”.
        </p>

        <div className="mt-4 rounded-md bg-amber-50 dark:bg-amber-900/20 p-3">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
            Qué va a pasar con {preview.linkedTotal} registro(s) enlazados
          </p>
          <ul className="mt-2 space-y-1 text-xs text-amber-800 dark:text-amber-200 list-disc pl-4">
            {preview.effects.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-amber-900 dark:text-amber-100">
            No se borra nada: oportunidades, pedidos, montos, etapas, historial y asesores
            quedan intactos. Solo se sueltan los identificadores del sistema que dejas atrás,
            para que un ID idéntico del sistema nuevo no matchee contra un registro viejo.
          </p>
        </div>

        <label className="block mt-4">
          <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
            {card.discriminatorLabel} actual
          </span>
          <span className="font-mono text-sm text-gray-500 dark:text-gray-400">
            {preview.currentDiscriminator ?? "— sin definir —"}
          </span>
        </label>

        <label className="block mt-3">
          <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
            {card.discriminatorLabel} nuevo
          </span>
          <input
            type="text"
            value={newDiscriminator}
            onChange={(e) => setNewDiscriminator(e.target.value)}
            placeholder={card.discriminatorPlaceholder}
            disabled={busy}
            autoFocus
            className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100 font-mono"
          />
        </label>

        {card.provider === "shopify" && (
          <label className="block mt-3">
            <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
              URL pública de la tienda (opcional)
            </span>
            <input
              type="text"
              value={storeUrl}
              onChange={(e) => setStoreUrl(e.target.value)}
              placeholder="https://mitienda.com"
              disabled={busy}
              className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100"
            />
          </label>
        )}

        <label className="block mt-4">
          <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
            Escribe <span className="font-mono">{preview.confirmationWord}</span> para confirmar
          </span>
          <input
            type="text"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            disabled={busy}
            autoComplete="off"
            className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100"
          />
        </label>

        <div className="flex justify-end gap-2 pt-5">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="px-3 py-1.5 text-sm rounded-md bg-amber-600 text-white hover:bg-amber-700 disabled:bg-amber-300"
          >
            {busy ? "Reemplazando..." : "Reemplazar conexión"}
          </button>
        </div>
      </form>
    </div>
  );
}
