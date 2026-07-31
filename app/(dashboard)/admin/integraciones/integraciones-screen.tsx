"use client";
import { useState } from "react";
import {
  disconnectIntegrationAction,
  previewReplaceIntegrationAction,
  replaceIntegrationAction,
  saveIntegrationCredentialsAction,
  saveIntegrationDiscriminatorAction,
  testIntegrationAction,
  type IntegrationCardView,
  type ReplacePreview,
} from "@/lib/actions/admin-integrations";
import type { IntegrationProvider } from "@/lib/types/database";
import { IntegrationCard } from "./integration-card";
import { CredentialsModal } from "./credentials-modal";
import { ReplaceModal } from "./replace-modal";

interface Props {
  initialCards: IntegrationCardView[];
}

type Banner = { tone: "error" | "success"; text: string } | null;

/**
 * Admin → Integraciones (0046). Orquesta las tres tarjetas y los dos flujos
 * con modal (capturar credenciales, reemplazar conexión).
 */
export function IntegracionesScreen({ initialCards }: Props) {
  const [cards, setCards] = useState(initialCards);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const [credentialsFor, setCredentialsFor] = useState<IntegrationProvider | null>(null);
  const [replaceState, setReplaceState] = useState<{
    provider: IntegrationProvider;
    preview: ReplacePreview;
  } | null>(null);
  const [disconnectFor, setDisconnectFor] = useState<IntegrationCardView | null>(null);

  const cardFor = (p: IntegrationProvider) => cards.find((c) => c.provider === p) ?? null;

  function applyResult(res: { ok: boolean; message: string; cards?: IntegrationCardView[] }) {
    if (res.cards) setCards(res.cards);
    setBanner({ tone: res.ok ? "success" : "error", text: res.message });
  }

  async function run<T extends { ok: boolean; message: string; cards?: IntegrationCardView[] }>(
    fn: () => Promise<T>,
  ): Promise<T> {
    setBusy(true);
    const res = await fn();
    setBusy(false);
    applyResult(res);
    return res;
  }

  async function saveCredentials(provider: IntegrationProvider, values: Record<string, string>) {
    const res = await run(() => saveIntegrationCredentialsAction({ provider, values }));
    if (res.ok) setCredentialsFor(null);
  }

  async function saveDiscriminator(provider: IntegrationProvider, value: string) {
    setBusy(true);
    const res = await saveIntegrationDiscriminatorAction({ provider, value });
    setBusy(false);
    applyResult(res);
    // El backend decide si el cambio exige el flujo de reemplazo; la UI solo
    // abre el modal cuando el servidor lo pide (nunca al revés).
    if (!res.ok && res.requiresReplacement) await openReplace(provider);
  }

  async function openReplace(provider: IntegrationProvider) {
    setBusy(true);
    const res = await previewReplaceIntegrationAction({ provider });
    setBusy(false);
    if (!res.ok) {
      setBanner({ tone: "error", text: res.message });
      return;
    }
    setReplaceState({ provider, preview: res.preview });
  }

  async function confirmReplace(input: {
    newDiscriminator: string;
    storeUrl: string | null;
    confirmation: string;
  }) {
    if (!replaceState) return;
    const res = await run(() =>
      replaceIntegrationAction({ provider: replaceState.provider, ...input }),
    );
    if (res.ok) setReplaceState(null);
  }

  async function confirmDisconnect() {
    if (!disconnectFor) return;
    const provider = disconnectFor.provider;
    setDisconnectFor(null);
    await run(() => disconnectIntegrationAction({ provider }));
  }

  const credentialsCard = credentialsFor ? cardFor(credentialsFor) : null;
  const replaceCard = replaceState ? cardFor(replaceState.provider) : null;

  return (
    <div className="max-w-3xl mx-auto">
      <header className="mb-4">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Integraciones</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
          Conecta, cambia o desconecta Shopify y las dos instancias de Whaapy. Las credenciales
          se guardan cifradas y no se pueden volver a ver desde aquí.
        </p>
      </header>

      {banner && (
        <div
          role={banner.tone === "error" ? "alert" : "status"}
          className={`mb-3 px-3 py-2 rounded-md text-sm flex items-start justify-between gap-3 ${
            banner.tone === "error"
              ? "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300"
              : "bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300"
          }`}
        >
          <span>{banner.text}</span>
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="text-xs underline opacity-80 hover:opacity-100 whitespace-nowrap"
          >
            cerrar
          </button>
        </div>
      )}

      <div className="space-y-4">
        {cards.map((card) => (
          <IntegrationCard
            key={card.provider}
            card={card}
            busy={busy}
            onEditCredentials={() => setCredentialsFor(card.provider)}
            onTest={() => run(() => testIntegrationAction({ provider: card.provider }))}
            onReplace={() => openReplace(card.provider)}
            onDisconnect={() => setDisconnectFor(card)}
            onSaveDiscriminator={(value) => saveDiscriminator(card.provider, value)}
          />
        ))}
      </div>

      {credentialsCard && (
        <CredentialsModal
          card={credentialsCard}
          busy={busy}
          onCancel={() => setCredentialsFor(null)}
          onSubmit={(values) => saveCredentials(credentialsCard.provider, values)}
        />
      )}

      {replaceState && replaceCard && (
        <ReplaceModal
          card={replaceCard}
          preview={replaceState.preview}
          busy={busy}
          onCancel={() => setReplaceState(null)}
          onSubmit={confirmReplace}
        />
      )}

      {disconnectFor && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-gray-900/40 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          onClick={busy ? undefined : () => setDisconnectFor(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-sm w-full p-6"
          >
            <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Desconectar {disconnectFor.label}
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-300 mt-2">
              Se borran las credenciales y la plataforma deja de hablar con este sistema. No se
              borra ni se desenlaza nada: al volver a capturar las credenciales del mismo
              sistema, todo sigue enlazado como estaba.
            </p>
            <div className="flex justify-end gap-2 mt-5">
              <button
                type="button"
                onClick={() => setDisconnectFor(null)}
                disabled={busy}
                className="px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={confirmDisconnect}
                disabled={busy}
                className="px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300"
              >
                {busy ? "Desconectando..." : "Desconectar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
