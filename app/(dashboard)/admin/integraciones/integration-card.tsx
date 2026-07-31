"use client";
import { useState } from "react";
import type { IntegrationCardView } from "@/lib/actions/admin-integrations";
import type { IntegrationHealth } from "@/lib/services/integration-providers";

const HEALTH_STYLE: Record<IntegrationHealth, { label: string; className: string }> = {
  connected: {
    label: "Configurada",
    className: "bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  },
  incomplete: {
    label: "Incompleta",
    className: "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  },
  disconnected: {
    label: "Desconectada",
    className: "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300",
  },
  not_configured: {
    label: "Sin configurar",
    className: "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400",
  },
};

interface Props {
  card: IntegrationCardView;
  busy: boolean;
  onEditCredentials: () => void;
  onTest: () => void;
  onReplace: () => void;
  onDisconnect: () => void;
  onSaveDiscriminator: (value: string) => void;
}

function formatDate(iso: string | null): string {
  if (!iso) return "nunca";
  return new Date(iso).toLocaleString("es-MX", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function IntegrationCard({
  card,
  busy,
  onEditCredentials,
  onTest,
  onReplace,
  onDisconnect,
  onSaveDiscriminator,
}: Props) {
  const [editingDiscriminator, setEditingDiscriminator] = useState(false);
  const [draft, setDraft] = useState(card.discriminatorValue ?? "");
  const [copied, setCopied] = useState(false);
  const health = HEALTH_STYLE[card.health];

  async function copyCallback() {
    try {
      await navigator.clipboard.writeText(card.callbackUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            {card.label}
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${health.className}`}>
              {health.label}
            </span>
            {card.generation > 1 && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300">
                generación {card.generation}
              </span>
            )}
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{card.description}</p>
        </div>
      </header>

      <p className="text-sm text-gray-700 dark:text-gray-300 mt-3">{card.summary}</p>

      {/* Identificador que resuelve el tenant en cada webhook entrante. */}
      <div className="mt-4">
        <p className="text-xs font-medium text-gray-600 dark:text-gray-300">
          {card.discriminatorLabel}
        </p>
        {editingDiscriminator ? (
          <div className="flex items-center gap-2 mt-1">
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={card.discriminatorPlaceholder}
              disabled={busy}
              className="flex-1 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100"
            />
            <button
              type="button"
              disabled={busy || !draft.trim()}
              onClick={() => {
                onSaveDiscriminator(draft.trim());
                setEditingDiscriminator(false);
              }}
              className="px-2 py-1 text-xs rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300"
            >
              Guardar
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setDraft(card.discriminatorValue ?? "");
                setEditingDiscriminator(false);
              }}
              className="px-2 py-1 text-xs rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200"
            >
              Cancelar
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 mt-1">
            <span className="font-mono text-sm text-gray-900 dark:text-gray-100 truncate">
              {card.discriminatorValue ?? "— sin definir —"}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setDraft(card.discriminatorValue ?? "");
                setEditingDiscriminator(true);
              }}
              className="text-xs underline text-indigo-600 dark:text-indigo-400"
            >
              editar
            </button>
          </div>
        )}
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{card.discriminatorHint}</p>
        {card.requiresReplacement && (
          <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
            Hay {card.linkedTotal} registro(s) enlazados. Cambiar este identificador exige el
            flujo “Reemplazar conexión”.
          </p>
        )}
      </div>

      {/* Credenciales — write-only: solo se muestran los últimos 4. */}
      <div className="mt-4">
        <p className="text-xs font-medium text-gray-600 dark:text-gray-300">Credenciales</p>
        <ul className="mt-1 space-y-1">
          {card.credentials.map((c) => (
            <li key={c.key} className="text-sm flex items-center gap-2">
              <span className="text-gray-700 dark:text-gray-300">{c.label}</span>
              {c.configured ? (
                // El last4 puede faltar en credenciales que entraron al Vault
                // por fuera de la pantalla (adopción desde entorno): entonces
                // se dice "configurada" en vez de fingir un valor enmascarado.
                <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
                  {c.last4 ? `••••${c.last4}` : "configurada"}
                </span>
              ) : (
                <span
                  className={`text-xs ${
                    c.required
                      ? "text-amber-700 dark:text-amber-300"
                      : "text-gray-400 dark:text-gray-500"
                  }`}
                >
                  {c.required ? "sin configurar" : "opcional, sin configurar"}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>

      {/* URL que el proveedor debe llamar. */}
      <div className="mt-4">
        <p className="text-xs font-medium text-gray-600 dark:text-gray-300">
          URL para el webhook
        </p>
        <div className="flex items-center gap-2 mt-1">
          <code className="text-xs font-mono text-gray-700 dark:text-gray-300 truncate">
            {card.callbackUrl}
          </code>
          <button
            type="button"
            onClick={copyCallback}
            className="text-xs underline text-indigo-600 dark:text-indigo-400 whitespace-nowrap"
          >
            {copied ? "copiado" : "copiar"}
          </button>
        </div>
      </div>

      {/* Diagnóstico: qué llegó y qué se rechazó. */}
      {card.ingress && (
        <div className="mt-4 text-xs text-gray-500 dark:text-gray-400">
          Últimas {card.ingress.windowHours}h: {card.ingress.total} evento(s) recibido(s)
          {card.ingress.rejected > 0 && (
            <span className="text-red-600 dark:text-red-400">
              {" "}
              · {card.ingress.rejected} rechazado(s) por configuración
              {card.ingress.lastExitReason ? ` (${card.ingress.lastExitReason})` : ""}
            </span>
          )}
        </div>
      )}

      {card.lastTestAt && (
        <p
          className={`mt-2 text-xs ${
            card.lastTestOk
              ? "text-green-700 dark:text-green-300"
              : "text-red-600 dark:text-red-400"
          }`}
        >
          Última prueba ({formatDate(card.lastTestAt)}): {card.lastTestMessage}
        </p>
      )}

      <div className="flex flex-wrap gap-2 mt-4">
        <button
          type="button"
          onClick={onEditCredentials}
          disabled={busy}
          className="px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300"
        >
          Capturar credenciales
        </button>
        <button
          type="button"
          onClick={onTest}
          disabled={busy}
          className="px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
        >
          Probar conexión
        </button>
        <button
          type="button"
          onClick={onReplace}
          disabled={busy}
          className="px-3 py-1.5 text-sm rounded-md border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-900/20 disabled:opacity-50"
        >
          Reemplazar conexión
        </button>
        {card.status !== "disconnected" && (
          <button
            type="button"
            onClick={onDisconnect}
            disabled={busy}
            className="px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
          >
            Desconectar
          </button>
        )}
      </div>
    </section>
  );
}
