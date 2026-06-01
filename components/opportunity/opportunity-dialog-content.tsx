"use client";
import Link from "next/link";
import { useCallback } from "react";
import type { OpportunityDialogBundle } from "@/lib/actions/opportunities-m6";
import { effectiveAmount, formatAmount } from "@/lib/format/money";
import { resolveAdvisor, formatRelative } from "@/app/(dashboard)/contactos/utils";
import { OpportunityLineItems } from "./opportunity-line-items";
import { OpportunityLossInfo } from "./opportunity-loss-info";
import { OpportunityTimeline } from "./opportunity-timeline";

interface Props {
  bundle: OpportunityDialogBundle;
  /** Cierra el popup desde el padre (ESC, click fuera, navegación). */
  onClose: () => void;
  /** Stubs reemplazables por B6/B7/B9. */
  onAddNote?: () => void;
  onCreateTask?: () => void;
  onReassign?: () => void;
  onCreateInShopify?: () => void;
}

/**
 * Contenido del popup de detalle de oportunidad (M6 — B4).
 *
 * Renderiza:
 *   - Header con contacto (clickeable → cierra y navega), etapa,
 *     monto, asesor, link de cobro si invoice_url.
 *   - Bloque de pérdida si etapa is_lost.
 *   - Tabla de line items.
 *   - Timeline de la oportunidad.
 *   - Botones de acción según permisos.
 *
 * Los handlers vienen como stubs en B4; B6/B7/B9 los reemplazan
 * con modales reales sin refactor de este shell.
 */
export function OpportunityDialogContent({
  bundle,
  onClose,
  onAddNote,
  onCreateTask,
  onReassign,
  onCreateInShopify,
}: Props) {
  const { opportunity, stage, contact, lineItems, lossReason } = bundle.detail;
  const amount = effectiveAmount(opportunity);
  const moneyText = formatAmount(amount.value, opportunity.currency);
  const advisor = resolveAdvisor(opportunity.assigned_advisor_id, bundle.advisors);

  // Click en nombre del contacto → cerrar popup y navegar a /contactos/[id].
  // Se usa el evento del Link para asegurar que el popup se cierra ANTES
  // de la navegación (sin esto, el efecto de cierre y la transición compiten).
  const handleContactClick = useCallback(() => {
    onClose();
  }, [onClose]);

  return (
    <div className="flex flex-col gap-4">
      <header>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <Link
              href={`/contactos/${contact.id}`}
              onClick={handleContactClick}
              className="group inline-flex items-center gap-1.5 text-base font-semibold text-indigo-600 dark:text-indigo-300 hover:underline"
              aria-label={`Abrir detalle del contacto ${contact.full_name ?? contact.phone ?? "sin nombre"}`}
            >
              <span className="truncate">
                {contact.full_name ?? contact.email ?? contact.phone ?? "Sin nombre"}
              </span>
              <span className="text-xs font-normal opacity-70 group-hover:opacity-100">
                Ver contacto →
              </span>
            </Link>
            <div className="mt-1 flex items-center gap-2 flex-wrap">
              <span
                className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: stage.color }}
              />
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {stage.name}
              </span>
              {opportunity.display_reference && (
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {opportunity.display_reference}
                </span>
              )}
              {opportunity.cancelled_at && (
                <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                  Cancelada
                </span>
              )}
              <SystemBadge kind="shopify" active={contact.shopify_customer_id !== null} />
              <SystemBadge kind="whaapy" active={contact.whaapy_contact_id !== null} />
              <ContactTypeBadge isCustomer={contact.contactType === "cliente"} />
            </div>
            <div className="mt-2 flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400 flex-wrap">
              <span className="flex items-center gap-1.5">
                <span
                  className="inline-block w-2 h-2 rounded-full"
                  style={{ backgroundColor: advisor.color }}
                />
                {advisor.fullName}
              </span>
              <span>Actualizada: {formatRelative(opportunity.last_modified_at)}</span>
              {opportunity.won_at && (
                <span className="text-emerald-700 dark:text-emerald-300">
                  Ganada: {formatRelative(opportunity.won_at)}
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-col items-end gap-2 flex-shrink-0">
            <span
              className={[
                "text-lg font-semibold tabular-nums",
                amount.value === null
                  ? "text-gray-400 italic"
                  : amount.isEstimated
                    ? "text-amber-700 dark:text-amber-300"
                    : "text-gray-900 dark:text-gray-100",
              ].join(" ")}
            >
              {moneyText ?? "Sin monto"}
            </span>
            {amount.isEstimated && (
              <span className="text-[11px] text-amber-700 dark:text-amber-300 uppercase tracking-wide">
                Estimado
              </span>
            )}
            {opportunity.invoice_url && (
              <a
                href={opportunity.invoice_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs px-2.5 py-1 rounded-md bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/50"
              >
                Ver link de cobro
              </a>
            )}
          </div>
        </div>
      </header>

      {stage.is_lost && (
        <OpportunityLossInfo
          opportunity={opportunity}
          lossReason={lossReason}
        />
      )}

      <OpportunityLineItems items={lineItems} currency={opportunity.currency} />

      <OpportunityTimeline events={bundle.timeline} />

      <footer className="flex items-center gap-2 flex-wrap border-t border-gray-200 dark:border-gray-700 pt-3">
        {bundle.canAddNote && (
          <button
            type="button"
            onClick={onAddNote}
            className="px-3 py-1.5 text-sm rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
          >
            Agregar nota
          </button>
        )}
        {bundle.canCreateTask && (
          <button
            type="button"
            onClick={onCreateTask}
            className="px-3 py-1.5 text-sm rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
          >
            Crear tarea
          </button>
        )}
        {bundle.canReassign && (
          <button
            type="button"
            onClick={onReassign}
            className="px-3 py-1.5 text-sm rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
          >
            Reasignar asesor
          </button>
        )}
        {bundle.canCreateInShopify && (
          <button
            type="button"
            onClick={onCreateInShopify}
            className="px-3 py-1.5 text-sm rounded-md bg-emerald-600 text-white hover:bg-emerald-700"
          >
            Crear contacto en Shopify
          </button>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
        >
          Cerrar
        </button>
      </footer>
    </div>
  );
}

function SystemBadge({ kind, active }: { kind: "shopify" | "whaapy"; active: boolean }) {
  if (!active) return null;
  const label = kind === "shopify" ? "Shopify" : "Whaapy";
  return (
    <span
      className={[
        "text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded",
        kind === "shopify"
          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
          : "bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300",
      ].join(" ")}
    >
      {label}
    </span>
  );
}

function ContactTypeBadge({ isCustomer }: { isCustomer: boolean }) {
  return (
    <span
      className={[
        "text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded",
        isCustomer
          ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300"
          : "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300",
      ].join(" ")}
    >
      {isCustomer ? "Cliente" : "Lead"}
    </span>
  );
}
