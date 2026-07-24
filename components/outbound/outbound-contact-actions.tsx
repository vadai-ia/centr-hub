"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addContactToOutboundAction,
  unsetContactOutboundAction,
} from "@/lib/actions/outbound";

/**
 * Acciones de la marca outbound en el detalle de contacto (Fase 2).
 *
 * - "Meter a Outbound" (admin/SDR, si el contacto NO es outbound): lo trabaja
 *   el SDR — marca outbound + crea su oportunidad en el pipeline Outbound.
 * - "Quitar marca outbound" (solo admin, si el contacto ES outbound):
 *   corrección de un marcado erróneo.
 *
 * Self-contained: llama las server actions y refresca. Sin plumbing de
 * handlers por el árbol.
 */
export function OutboundContactActions({
  contactId,
  isOutbound,
  canManage,
  canUnset,
}: {
  contactId: string;
  isOutbound: boolean;
  canManage: boolean;
  canUnset: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const showAdd = canManage && !isOutbound;
  const showUnset = canUnset && isOutbound;
  if (!showAdd && !showUnset) return null;

  function run(action: "add" | "unset") {
    setMsg(null);
    startTransition(async () => {
      const res =
        action === "add"
          ? await addContactToOutboundAction({ contactId })
          : await unsetContactOutboundAction({ contactId });
      setMsg({ tone: res.ok ? "ok" : "err", text: res.message });
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {showAdd && (
        <button
          type="button"
          disabled={pending}
          onClick={() => run("add")}
          className="px-3 py-1.5 text-sm rounded-md bg-cyan-600 text-white hover:bg-cyan-700 disabled:bg-cyan-300"
        >
          {pending ? "Procesando…" : "Meter a Outbound"}
        </button>
      )}
      {showUnset && (
        <button
          type="button"
          disabled={pending}
          onClick={() => run("unset")}
          title="Corrección administrativa: quita la marca outbound del contacto y sus oportunidades activas."
          className="px-3 py-1.5 text-sm rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
        >
          {pending ? "Procesando…" : "Quitar marca outbound"}
        </button>
      )}
      {msg && (
        <span
          role={msg.tone === "err" ? "alert" : "status"}
          className={
            msg.tone === "err"
              ? "text-xs text-red-600 dark:text-red-400"
              : "text-xs text-green-600 dark:text-green-400"
          }
        >
          {msg.text}
        </span>
      )}
    </div>
  );
}
