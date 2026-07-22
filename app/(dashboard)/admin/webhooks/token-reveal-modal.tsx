"use client";
import { useState } from "react";

interface Props {
  open: boolean;
  sourceName: string;
  endpointUrl: string;
  token: string;
  onClose: () => void;
}

/**
 * Modal "copiar ahora" del token de una fuente de webhook (0038). El token
 * se muestra UNA sola vez tras crear o rotar la fuente — en BD solo vive su
 * hash, así que NO se puede recuperar después. Muestra el endpoint + el
 * token con botones de copiar.
 */
export function TokenRevealModal({ open, sourceName, endpointUrl, token, onClose }: Props) {
  const [copied, setCopied] = useState<"url" | "token" | null>(null);

  if (!open) return null;

  async function copy(value: string, which: "url" | "token") {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(which);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      // clipboard bloqueado — el usuario puede seleccionar manualmente
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-gray-900/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="token-reveal-title"
    >
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-lg w-full p-6">
        <p id="token-reveal-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Credenciales de “{sourceName}”
        </p>
        <div
          role="alert"
          className="mt-3 px-3 py-2 rounded-md bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200 text-sm"
        >
          <strong>Copia el token ahora.</strong> No se volverá a mostrar — solo guardamos una
          versión cifrada. Si lo pierdes, tendrás que rotarlo.
        </div>

        <label className="block mt-4">
          <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
            URL del webhook (endpoint)
          </span>
          <div className="flex gap-2">
            <input
              readOnly
              value={endpointUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-xs px-2 py-1.5 text-gray-900 dark:text-gray-100 font-mono"
            />
            <button
              type="button"
              onClick={() => copy(endpointUrl, "url")}
              className="px-2.5 py-1.5 text-xs rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 whitespace-nowrap"
            >
              {copied === "url" ? "Copiado" : "Copiar"}
            </button>
          </div>
        </label>

        <label className="block mt-3">
          <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
            Token (credencial)
          </span>
          <div className="flex gap-2">
            <input
              readOnly
              value={token}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-xs px-2 py-1.5 text-gray-900 dark:text-gray-100 font-mono"
            />
            <button
              type="button"
              onClick={() => copy(token, "token")}
              className="px-2.5 py-1.5 text-xs rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 whitespace-nowrap"
            >
              {copied === "token" ? "Copiado" : "Copiar"}
            </button>
          </div>
        </label>

        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
          La fuente debe enviar el token en el encabezado <code className="font-mono">x-centrhub-token</code>{" "}
          (o <code className="font-mono">Authorization: Bearer</code>). Consulta el documento del
          contrato para el formato del payload.
        </p>

        <div className="flex justify-end mt-5">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700"
          >
            Ya lo copié
          </button>
        </div>
      </div>
    </div>
  );
}
