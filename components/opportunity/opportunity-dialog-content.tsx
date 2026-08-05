"use client";
import Link from "next/link";
import { useCallback } from "react";
import type { OpportunityDialogBundle } from "@/lib/actions/opportunities-m6";
import { effectiveAmount, formatAmount } from "@/lib/format/money";
import {
  resolveAdvisor,
  resolveCustomerSuccess,
  formatRelative,
} from "@/app/(dashboard)/contactos/utils";
import { OpportunityLineItems } from "./opportunity-line-items";
import { OpportunityLossInfo } from "./opportunity-loss-info";
import { OpportunityTimeline } from "./opportunity-timeline";
import { OpportunityTasks } from "./opportunity-tasks";
import { OutboundBadge } from "@/components/outbound/outbound-badge";

interface Props {
  bundle: OpportunityDialogBundle;
  onClose: () => void;
  onAddNote?: () => void;
  onCreateTask?: () => void;
  onReassign?: () => void;
  onAssignCustomerSuccess?: () => void;
  onCreateInShopify?: () => void;
  onResolveCase?: () => void;
  onTasksChanged?: () => void;
}

/**
 * Contenido del popup de detalle de oportunidad.
 *
 * Lote polish M6:
 *  - Header con jerarquía clara: nombre primario + monto destacado.
 *  - Total etiquetado "Total de la orden" (incluye envío + impuestos).
 *  - Enlace al customer en Shopify Admin si existe (reemplaza al
 *    botón viejo "Ver link de cobro").
 *  - Secciones de productos / tareas / historia con encabezados
 *    coloreados y separados visualmente.
 */
export function OpportunityDialogContent({
  bundle,
  onClose,
  onAddNote,
  onCreateTask,
  onReassign,
  onAssignCustomerSuccess,
  onCreateInShopify,
  onResolveCase,
  onTasksChanged,
}: Props) {
  const { opportunity, stage, contact, lineItems, lossReason } = bundle.detail;
  const amount = effectiveAmount(opportunity);
  const totalText = formatAmount(amount.value, opportunity.currency);
  const subtotalText = formatAmount(bundle.lineItemsSubtotal, opportunity.currency);
  const advisor = resolveAdvisor(opportunity.assigned_advisor_id, bundle.advisors);
  // Conflicto de asesor por tag de Shopify (0043): el tag nombró a otro pero
  // se conservó el asesor de la entrega. Se resuelve el nombre para advertir.
  const tagConflictAdvisor = opportunity.overridden_tag_advisor_id
    ? resolveAdvisor(opportunity.overridden_tag_advisor_id, bundle.advisors)
    : null;
  // Segunda ranura de Post-venta (0047). Se resuelve contra su propio
  // catálogo (Customer Success activos) — un CS no está en `advisors`.
  const isPostventa = opportunity.funnel === "post_venta";
  const customerSuccess = isPostventa
    ? resolveCustomerSuccess(
        opportunity.customer_success_membership_id,
        bundle.customerSuccessOptions,
      )
    : null;

  const handleContactClick = useCallback(() => {
    onClose();
  }, [onClose]);

  // Diferencia entre total (orden Shopify) y subtotal (suma productos).
  const hasDeltaFromShopifyTotal =
    amount.value !== null &&
    bundle.lineItemsSubtotal > 0 &&
    Math.abs(Number(amount.value) - bundle.lineItemsSubtotal) > 0.01;

  return (
    <div className="flex flex-col gap-4">
      <header className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gradient-to-br from-amber-50/60 via-white to-white dark:from-amber-500/5 dark:via-gray-800 dark:to-gray-800 p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <Link
              href={`/contactos/${contact.id}`}
              onClick={handleContactClick}
              className="group inline-flex items-center gap-1.5 text-lg font-semibold text-gray-900 dark:text-gray-50 hover:text-amber-700 dark:hover:text-amber-300 transition-colors"
              aria-label={`Abrir detalle del contacto ${contact.full_name ?? contact.phone ?? "sin nombre"}`}
            >
              <span className="truncate">
                {contact.full_name ?? contact.email ?? contact.phone ?? "Sin nombre"}
              </span>
              <span className="text-xs font-medium text-gray-400 group-hover:text-amber-600 dark:group-hover:text-amber-300 transition-colors">
                ↗
              </span>
            </Link>
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              <StagePill stage={stage} />
              {opportunity.display_reference && (
                <span className="text-xs font-mono text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700/60 px-2 py-0.5 rounded">
                  {opportunity.display_reference}
                </span>
              )}
              {opportunity.cancelled_at && (
                <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                  Cancelada
                </span>
              )}
              {bundle.resolution && (
                <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                  Resuelto
                </span>
              )}
              <SystemBadge kind="shopify" active={contact.shopify_customer_id !== null} />
              <SystemBadge kind="whaapy" active={contact.whaapy_contact_id !== null} />
              <ContactTypeBadge isCustomer={contact.contactType === "cliente"} />
              {opportunity.is_outbound && <OutboundBadge />}
            </div>
            <div className="mt-3 flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400 flex-wrap">
              <span className="flex items-center gap-1.5">
                <span
                  className="inline-block w-2 h-2 rounded-full ring-2 ring-white dark:ring-gray-800"
                  style={{ backgroundColor: advisor.color }}
                />
                <span className={advisor.isUnassigned ? "italic text-amber-700 dark:text-amber-300" : ""}>
                  {advisor.fullName}
                </span>
              </span>
              {/* Segunda ranura (0047): se pinta al lado del asesor, con
                  etiqueta explícita para que no se lea como "otro asesor". */}
              {customerSuccess && (
                <span className="flex items-center gap-1.5">
                  <span
                    className="inline-block w-2 h-2 rounded-full ring-2 ring-white dark:ring-gray-800"
                    style={{ backgroundColor: customerSuccess.color }}
                  />
                  <span className="text-gray-400 dark:text-gray-500">CS:</span>
                  <span
                    className={
                      customerSuccess.isUnassigned
                        ? "italic text-amber-700 dark:text-amber-300"
                        : ""
                    }
                  >
                    {customerSuccess.fullName}
                  </span>
                </span>
              )}
              <span>· Actualizada {formatRelative(opportunity.last_modified_at)}</span>
              {opportunity.won_at && (
                <span className="text-emerald-700 dark:text-emerald-300 font-medium">
                  · Ganada {formatRelative(opportunity.won_at)}
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-col items-end gap-1 flex-shrink-0">
            <span className="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400 font-semibold">
              Total de la orden
            </span>
            <span
              className={[
                "text-2xl font-bold tabular-nums leading-none",
                amount.value === null
                  ? "text-gray-400 italic"
                  : amount.isEstimated
                    ? "text-amber-700 dark:text-amber-300"
                    : "text-gray-900 dark:text-gray-50",
              ].join(" ")}
              title={hasDeltaFromShopifyTotal ? "Incluye envío + impuestos + ajustes (total de la orden Shopify)" : undefined}
            >
              {totalText ?? "Sin monto"}
            </span>
            {amount.isEstimated && (
              <span className="text-[10px] text-amber-700 dark:text-amber-300 uppercase tracking-wide font-medium">
                Estimado
              </span>
            )}
            {hasDeltaFromShopifyTotal && (
              <span className="text-[10px] text-gray-500 dark:text-gray-400">
                Productos: {subtotalText}
              </span>
            )}
            {bundle.shopifyCustomerUrl && (
              <a
                href={bundle.shopifyCustomerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 text-xs font-medium inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                  <polyline points="15 3 21 3 21 9"/>
                  <line x1="10" y1="14" x2="21" y2="3"/>
                </svg>
                Cliente en Shopify
              </a>
            )}
          </div>
        </div>
      </header>

      {tagConflictAdvisor && !tagConflictAdvisor.isUnassigned && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50/70 dark:bg-amber-500/5 p-3">
          <p className="text-xs text-amber-800 dark:text-amber-300">
            ⚠ Shopify asignó a <strong>{tagConflictAdvisor.fullName}</strong> por su tag, pero se
            mantuvo el asesor de la entrega{" "}
            {advisor.isUnassigned ? "" : <strong>({advisor.fullName})</strong>}. Puedes reasignar
            manualmente si corresponde.
          </p>
        </div>
      )}

      {stage.is_lost && (
        <OpportunityLossInfo opportunity={opportunity} lossReason={lossReason} />
      )}

      {bundle.resolution && (
        <div className="rounded-lg border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50/60 dark:bg-emerald-500/5 p-4">
          <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">
            Caso resuelto
          </p>
          <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">
            {formatRelative(bundle.resolution.resolvedAt)}
            {bundle.resolution.resolvedByName
              ? ` · por ${bundle.resolution.resolvedByName}`
              : ""}
          </p>
          {bundle.resolution.note && (
            <p className="mt-2 text-sm text-gray-700 dark:text-gray-200 whitespace-pre-wrap">
              {bundle.resolution.note}
            </p>
          )}
        </div>
      )}

      <OpportunityLineItems items={lineItems} currency={opportunity.currency} />

      <OpportunityTasks
        tasks={bundle.tasks}
        canCreate={bundle.canCreateTask}
        canManage={bundle.canManageTasks}
        onCreateClick={() => onCreateTask?.()}
        onChanged={() => onTasksChanged?.()}
      />

      <OpportunityTimeline events={bundle.timeline} />

      <footer className="flex items-center gap-2 flex-wrap border-t border-gray-200 dark:border-gray-700 pt-3">
        {bundle.canAddNote && (
          <button
            type="button"
            onClick={onAddNote}
            className="px-3 py-1.5 text-sm font-medium rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600 transition-colors"
          >
            Agregar nota
          </button>
        )}
        {bundle.canReassign && (
          <button
            type="button"
            onClick={onReassign}
            className="px-3 py-1.5 text-sm font-medium rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600 transition-colors"
          >
            Reasignar asesor
          </button>
        )}
        {bundle.canAssignCustomerSuccess && (
          <button
            type="button"
            onClick={onAssignCustomerSuccess}
            className="px-3 py-1.5 text-sm font-medium rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600 transition-colors"
          >
            {opportunity.customer_success_membership_id
              ? "Cambiar Customer Success"
              : "Asignar Customer Success"}
          </button>
        )}
        {bundle.canCreateInShopify && (
          <button
            type="button"
            onClick={onCreateInShopify}
            className="px-3 py-1.5 text-sm font-medium rounded-md bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
          >
            Crear contacto en Shopify
          </button>
        )}
        {bundle.canResolveCase && (
          <button
            type="button"
            onClick={onResolveCase}
            className="px-3 py-1.5 text-sm font-medium rounded-md bg-amber-600 text-white hover:bg-amber-700 transition-colors"
          >
            Marcar caso como resuelto
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

function StagePill({ stage }: { stage: { name: string; color: string; is_won: boolean; is_lost: boolean } }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs font-semibold px-2 py-0.5 rounded-full border"
      style={{
        backgroundColor: `${stage.color}1A`,
        borderColor: `${stage.color}55`,
        color: stage.color,
      }}
    >
      <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: stage.color }} />
      {stage.name}
    </span>
  );
}

function SystemBadge({ kind, active }: { kind: "shopify" | "whaapy"; active: boolean }) {
  if (!active) return null;
  const label = kind === "shopify" ? "Shopify" : "Whaapy";
  return (
    <span
      className={[
        "text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-medium",
        kind === "shopify"
          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
          : "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
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
        "text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-medium",
        isCustomer
          ? "bg-purple-100 text-purple-700 dark:bg-purple-500/15 dark:text-purple-300"
          : "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
      ].join(" ")}
    >
      {isCustomer ? "Cliente" : "Lead"}
    </span>
  );
}
