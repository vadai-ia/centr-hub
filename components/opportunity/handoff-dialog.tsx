"use client";
import { useEffect, useState } from "react";
import { handoffOutboundOpportunityAction } from "@/lib/actions/outbound";
import type { AdvisorOption } from "@/lib/actions/contacts";

/**
 * Modal de entrega (handoff) Outbound → Venta (Fase 3). El SDR/admin elige el
 * vendedor y confirma; la opp flipea al Funnel Venta en "Contacto calificado"
 * con ese asesor y sale de Outbound. El SDR conserva visibilidad (data_scope
 * 'all' + la marca outbound permanece).
 */
export function HandoffDialog({
  open,
  opportunityId,
  advisors,
  onCancel,
  onSuccess,
}: {
  open: boolean;
  opportunityId: string | null;
  advisors: AdvisorOption[];
  onCancel: () => void;
  onSuccess: (message: string) => void;
}) {
  const [advisorId, setAdvisorId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setAdvisorId("");
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  if (!open || !opportunityId) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (!advisorId) {
      setError("Elige un vendedor.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const res = await handoffOutboundOpportunityAction({
      opportunityId,
      advisorMembershipId: advisorId,
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onSuccess(res.message);
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center px-4 bg-gray-900/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={submitting ? undefined : onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6"
      >
        <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Entregar a vendedor
        </p>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          La oportunidad pasa al Funnel Venta en &quot;Contacto calificado&quot; con el vendedor
          elegido y sale de Outbound. Conservas visibilidad; la marca outbound permanece.
        </p>

        <form onSubmit={submit} className="mt-4 space-y-3">
          <label className="block">
            <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
              Vendedor
            </span>
            <select
              value={advisorId}
              onChange={(e) => setAdvisorId(e.target.value)}
              disabled={submitting}
              autoFocus
              className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100"
            >
              <option value="">
                {advisors.length ? "Elige un vendedor…" : "No hay vendedores disponibles"}
              </option>
              {advisors.map((a) => (
                <option key={a.membershipId} value={a.membershipId}>
                  {a.fullName ?? "Vendedor"}
                </option>
              ))}
            </select>
          </label>

          {error && (
            <div role="alert" className="px-3 py-2 rounded-md bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300 text-sm">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting}
              className="px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={submitting || !advisorId}
              className="px-3 py-1.5 text-sm rounded-md bg-cyan-600 text-white hover:bg-cyan-700 disabled:bg-cyan-300"
            >
              {submitting ? "Entregando…" : "Entregar"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
