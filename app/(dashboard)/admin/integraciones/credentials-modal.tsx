"use client";
import { useState } from "react";
import type { IntegrationCardView } from "@/lib/actions/admin-integrations";

interface Props {
  card: IntegrationCardView;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (values: Record<string, string>) => void;
}

/**
 * Captura de credenciales — WRITE-ONLY.
 *
 * Los campos arrancan VACÍOS aunque la credencial ya exista: el valor guardado
 * no se puede leer (ni desde aquí ni desde ninguna otra parte de la app).
 * Dejar un campo vacío significa "no la toques", que es lo que permite rotar
 * un solo secreto sin volver a capturar el resto.
 */
export function CredentialsModal({ card, busy, onCancel, onSubmit }: Props) {
  const [values, setValues] = useState<Record<string, string>>({});

  const filled = Object.values(values).filter((v) => v.trim().length > 0).length;

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
          if (filled === 0) return;
          onSubmit(values);
        }}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-lg w-full p-6 max-h-[90vh] overflow-y-auto"
      >
        <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Credenciales de {card.label}
        </p>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Los valores guardados no se pueden volver a ver. Deja un campo vacío para conservar
          el valor actual.
        </p>

        <div className="mt-4 space-y-4">
          {card.credentials.map((c) => (
            <label key={c.key} className="block">
              <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
                {c.label}
                {!c.required && (
                  <span className="text-gray-400 dark:text-gray-500"> (opcional)</span>
                )}
                {c.configured && (
                  <span className="ml-2 font-mono text-gray-400 dark:text-gray-500">
                    {c.last4 ? `actual ••••${c.last4}` : "ya configurada"}
                  </span>
                )}
              </span>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={values[c.key] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [c.key]: e.target.value }))}
                placeholder={c.configured ? "Dejar vacío para no cambiarla" : "Pegar valor"}
                disabled={busy}
                className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100 font-mono"
              />
              <span className="block text-xs text-gray-500 dark:text-gray-400 mt-1">
                {c.hint}
              </span>
            </label>
          ))}
        </div>

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
            disabled={busy || filled === 0}
            className="px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300"
          >
            {busy ? "Guardando..." : "Guardar credenciales"}
          </button>
        </div>
      </form>
    </div>
  );
}
