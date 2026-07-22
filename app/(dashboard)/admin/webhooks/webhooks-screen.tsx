"use client";
import { useState } from "react";
import {
  createInboundWebhookSourceAction,
  rotateInboundWebhookSourceTokenAction,
  setInboundWebhookSourceActiveAction,
} from "@/lib/actions/admin-lead-webhooks";
import type { InboundWebhookSourceRow } from "@/lib/types/database";
import { TokenRevealModal } from "./token-reveal-modal";

interface Props {
  initialSources: InboundWebhookSourceRow[];
}

interface RevealState {
  sourceName: string;
  endpointUrl: string;
  token: string;
}

/**
 * Admin → Webhooks de leads (0038, Bloque B). Cada fuente externa tiene su
 * endpoint y credencial propios; se pueden revocar o rotar por separado. El
 * token se muestra una sola vez (modal "copiar ahora").
 */
export function WebhooksScreen({ initialSources }: Props) {
  const [sources, setSources] = useState(initialSources);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [reveal, setReveal] = useState<RevealState | null>(null);
  const [rotateTarget, setRotateTarget] = useState<InboundWebhookSourceRow | null>(null);

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !newName.trim()) return;
    setBusy(true);
    const res = await createInboundWebhookSourceAction({ name: newName.trim() });
    setBusy(false);
    if (!res.ok) {
      setBanner({ tone: "error", text: res.message });
      return;
    }
    setSources(res.sources);
    setCreateOpen(false);
    setNewName("");
    setReveal({ sourceName: res.source.name, endpointUrl: res.endpointUrl, token: res.token });
  }

  async function confirmRotate() {
    if (!rotateTarget || busy) return;
    setBusy(true);
    const res = await rotateInboundWebhookSourceTokenAction({ id: rotateTarget.id });
    setBusy(false);
    setRotateTarget(null);
    if (!res.ok) {
      setBanner({ tone: "error", text: res.message });
      return;
    }
    setSources(res.sources);
    setReveal({ sourceName: res.source.name, endpointUrl: res.endpointUrl, token: res.token });
  }

  async function toggleActive(source: InboundWebhookSourceRow) {
    setBusy(true);
    const res = await setInboundWebhookSourceActiveAction({ id: source.id, isActive: !source.is_active });
    setBusy(false);
    if (!res.ok) {
      setBanner({ tone: "error", text: res.message });
      return;
    }
    setSources(res.sources);
    setBanner({
      tone: "success",
      text: source.is_active ? "Fuente revocada." : "Fuente reactivada.",
    });
  }

  return (
    <div className="max-w-3xl mx-auto">
      <header className="flex items-center justify-between gap-4 mb-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            Webhooks de leads
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            Cada fuente externa (formulario web, landing de campaña) crea leads por su propio
            endpoint y credencial. Puedes revocar o rotar cada una sin afectar a las demás.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setNewName("");
            setCreateOpen(true);
          }}
          className="px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 whitespace-nowrap"
        >
          + Nueva fuente
        </button>
      </header>

      {banner && (
        <div
          role={banner.tone === "error" ? "alert" : "status"}
          className={`mb-3 px-3 py-2 rounded-md text-sm flex items-center justify-between gap-3 ${
            banner.tone === "error"
              ? "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300"
              : "bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300"
          }`}
        >
          <span>{banner.text}</span>
          <button type="button" onClick={() => setBanner(null)} className="text-xs underline opacity-80 hover:opacity-100">
            cerrar
          </button>
        </div>
      )}

      {sources.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 py-8 text-center">
          No hay fuentes. Crea la primera con “Nueva fuente”.
        </p>
      ) : (
        <ul className="space-y-2">
          {sources.map((s) => (
            <li
              key={s.id}
              className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 flex items-center gap-2">
                  <span className="truncate">{s.name}</span>
                  {!s.is_active && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400">
                      Revocada
                    </span>
                  )}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 font-mono truncate">
                  /api/webhooks/leads/{s.slug} · token ••••{s.token_last4}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRotateTarget(s)}
                disabled={busy}
                className="px-2 py-1 text-xs rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
              >
                Rotar token
              </button>
              <button
                type="button"
                onClick={() => toggleActive(s)}
                disabled={busy}
                className="px-2 py-1 text-xs rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
              >
                {s.is_active ? "Revocar" : "Reactivar"}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Modal crear fuente (solo nombre; el token se genera y se revela). */}
      {createOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-gray-900/40 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          onClick={busy ? undefined : () => setCreateOpen(false)}
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={submitCreate}
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6"
          >
            <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">Nueva fuente de leads</p>
            <label className="block mt-4">
              <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
                Nombre de la fuente
              </span>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={120}
                required
                autoFocus
                placeholder="Ej. Formulario Home, Landing Verano"
                disabled={busy}
                className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100"
              />
            </label>
            <div className="flex justify-end gap-2 pt-4">
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                disabled={busy}
                className="px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={busy || !newName.trim()}
                className="px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300"
              >
                {busy ? "Creando..." : "Crear fuente"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Confirmar rotación (invalida el token anterior). */}
      {rotateTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-gray-900/40 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          onClick={busy ? undefined : () => setRotateTarget(null)}
        >
          <div onClick={(e) => e.stopPropagation()} className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-sm w-full p-6">
            <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">Rotar token</p>
            <p className="text-sm text-gray-600 dark:text-gray-300 mt-2">
              Se generará un token nuevo para <span className="font-medium">{rotateTarget.name}</span> y el
              actual dejará de funcionar de inmediato. Tendrás que actualizar la fuente con el token nuevo.
            </p>
            <div className="flex justify-end gap-2 mt-5">
              <button
                type="button"
                onClick={() => setRotateTarget(null)}
                disabled={busy}
                className="px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={confirmRotate}
                disabled={busy}
                className="px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300"
              >
                {busy ? "Rotando..." : "Rotar token"}
              </button>
            </div>
          </div>
        </div>
      )}

      <TokenRevealModal
        open={reveal !== null}
        sourceName={reveal?.sourceName ?? ""}
        endpointUrl={reveal?.endpointUrl ?? ""}
        token={reveal?.token ?? ""}
        onClose={() => setReveal(null)}
      />
    </div>
  );
}
