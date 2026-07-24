"use client";
import Link from "next/link";
import type { ContactDetail } from "@/lib/db/contacts-detail";
import type { AdvisorOption } from "@/lib/actions/contacts";
import type { UUID } from "@/lib/types/database";
import {
  contactDisplayName,
  formatRelative,
  lastActivityISO,
  resolveAdvisor,
  systemIndicators,
} from "../utils";
import { OutboundBadge } from "@/components/outbound/outbound-badge";

interface Props {
  detail: ContactDetail;
  advisors: AdvisorOption[];
  canEdit: boolean;
  canReassign: boolean;
  onEdit?: () => void;
  onReassign?: () => void;
  onCreateInShopify?: () => void;
}

interface DerivedAdvisorState {
  advisorId: UUID | null;
  conflict: boolean;
}

function deriveAdvisorFromOpps(detail: ContactDetail): DerivedAdvisorState | null {
  if (detail.contact.assigned_advisor_id !== null) return null;
  const all = [...detail.opportunities.venta, ...detail.opportunities.postVenta]
    .filter((o) => o.cancelled_at === null)
    .map((o) => o.assigned_advisor_id)
    .filter((id): id is UUID => id !== null);
  const unique = Array.from(new Set(all));
  if (unique.length === 0) return null;
  if (unique.length === 1) return { advisorId: unique[0], conflict: false };
  return { advisorId: null, conflict: true };
}

/**
 * Header del detalle de contacto (M6 — B3).
 *
 * Muestra: nombre, badges identidades, badge lead/cliente, asesor,
 * última actividad, y los botones de acción según permisos.
 *
 * Los handlers `onEdit`, `onReassign`, `onCreateInShopify` los conecta
 * el wrapper `ContactDetailScreen`. En B3 algunos son stubs que B6/B7/B8
 * reemplazan. Mantener los botones visibles desde B3 hace que la pantalla
 * tenga estructura final completa sin huecos cosméticos.
 */
export function ContactHeader({
  detail,
  advisors,
  canEdit,
  canReassign,
  onEdit,
  onReassign,
  onCreateInShopify,
}: Props) {
  const { contact, contactType } = detail;
  const name = contactDisplayName(contact);
  const indicators = systemIndicators(contact);
  const ownAdvisor = resolveAdvisor(contact.assigned_advisor_id, advisors);
  const derived = deriveAdvisorFromOpps(detail);
  const displayAdvisor = derived && !derived.conflict
    ? resolveAdvisor(derived.advisorId, advisors)
    : ownAdvisor;
  const lastActivity = formatRelative(lastActivityISO(contact));
  const isLead = contactType === "lead";

  return (
    <header className="bg-white dark:bg-gray-800 rounded-md border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3 mb-2">
            <Link
              href="/contactos"
              className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            >
              ← Contactos
            </Link>
            {contact.anonymized_at && (
              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                Anonimizado por ARCO
              </span>
            )}
          </div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100 truncate">
            {name}
          </h1>
          <div className="flex items-center flex-wrap gap-2 mt-2">
            <SystemBadge kind="shopify" active={indicators.inShopify} />
            <SystemBadge kind="whaapy" active={indicators.inWhaapy} />
            <ContactTypeBadge isCustomer={contactType === "cliente"} />
            {contact.is_outbound && <OutboundBadge />}
            {contact.missing_phone && (
              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                Sin teléfono
              </span>
            )}
            {contact.deleted_in_shopify && (
              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300">
                Eliminado en Shopify
              </span>
            )}
            {contact.deleted_in_whaapy && (
              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300">
                Eliminado en Whaapy
              </span>
            )}
          </div>
          <div className="mt-3 flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400 flex-wrap">
            {derived?.conflict ? (
              <span
                className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300 font-medium"
                title="Las oportunidades de este contacto están asignadas a asesores distintos. Asigna manualmente para clarificar."
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="12" y1="8" x2="12" y2="12"/>
                  <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                Asesores múltiples (en sus oportunidades)
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <span
                  className="inline-block w-2 h-2 rounded-full"
                  style={{ backgroundColor: displayAdvisor.color }}
                />
                {displayAdvisor.fullName}
                {derived && !derived.conflict && (
                  <span
                    className="text-[9px] uppercase tracking-wide font-medium px-1 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300"
                    title="Asesor heredado de las oportunidades del contacto"
                  >
                    Heredado
                  </span>
                )}
              </span>
            )}
            <span>Última actividad: {lastActivity}</span>
          </div>
          {isLead && (
            <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">
              Este contacto es un <strong>lead</strong> sin identidad Shopify.
              Convertilo a cliente desde &quot;Crear contacto en Shopify&quot;.
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {canEdit && (
            <button
              type="button"
              onClick={onEdit}
              className="px-3 py-1.5 text-sm rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
            >
              Editar
            </button>
          )}
          {canReassign && (
            <button
              type="button"
              onClick={onReassign}
              className="px-3 py-1.5 text-sm rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
            >
              Reasignar asesor
            </button>
          )}
          {isLead && canEdit && (
            <button
              type="button"
              onClick={onCreateInShopify}
              disabled={!contact.phone}
              title={!contact.phone ? "Agrega teléfono al contacto antes de crear en Shopify" : undefined}
              className={[
                "px-3 py-1.5 text-sm rounded-md",
                "bg-emerald-600 text-white hover:bg-emerald-700",
                "disabled:bg-gray-300 disabled:text-gray-500 disabled:cursor-not-allowed",
                "dark:disabled:bg-gray-700 dark:disabled:text-gray-500",
              ].join(" ")}
            >
              Crear contacto en Shopify
            </button>
          )}
        </div>
      </div>
    </header>
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
