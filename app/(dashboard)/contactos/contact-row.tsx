"use client";
import Link from "next/link";
import type { ContactListRow } from "@/lib/db/contacts";
import type { AdvisorOption } from "@/lib/actions/contacts";
import {
  contactDisplayName,
  formatRelative,
  lastActivityISO,
  resolveAdvisor,
  systemIndicators,
} from "./utils";

interface Props {
  row: ContactListRow;
  advisors: AdvisorOption[];
}

/**
 * Fila del listado de Contactos (M6 — B2).
 *
 * Anclada como Link a /contactos/[id] (B3 construye el detalle).
 * Información: nombre, badges identidades (Shopify/Whaapy), badge
 * lead/cliente, asesor, última actividad, flag missing_phone/anonimizado.
 */
export function ContactRow({ row, advisors }: Props) {
  const name = contactDisplayName(row);
  const indicators = systemIndicators(row);
  const advisor = resolveAdvisor(row.assigned_advisor_id, advisors);
  const lastActivity = formatRelative(lastActivityISO(row));
  const isCustomer = row.contactType === "cliente";

  return (
    <Link
      href={`/contactos/${row.id}`}
      className={[
        "flex items-center justify-between gap-4 px-4 py-3 border-b border-gray-100 dark:border-gray-700",
        "bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors",
        "focus:outline-none focus:bg-indigo-50 dark:focus:bg-indigo-900/20",
      ].join(" ")}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
            {name}
          </p>
          {row.anonymized_at && (
            <span
              className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300"
              title="Contacto anonimizado por ARCO"
            >
              Anonimizado
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
          {row.phone && <span className="truncate">{row.phone}</span>}
          {row.email && (
            <span className="truncate hidden sm:inline">{row.email}</span>
          )}
          {row.missing_phone && (
            <span className="text-amber-700 dark:text-amber-300 font-medium">
              Sin teléfono
            </span>
          )}
        </div>
      </div>

      <div className="hidden md:flex flex-col items-end gap-1 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span
            className="inline-block w-2 h-2 rounded-full flex-shrink-0"
            style={{ backgroundColor: advisor.color }}
            aria-hidden
          />
          <span
            className={[
              "text-xs",
              advisor.isUnassigned
                ? "text-amber-700 dark:text-amber-300 italic"
                : "text-gray-600 dark:text-gray-400",
            ].join(" ")}
          >
            {advisor.fullName}
          </span>
        </div>
        <span className="text-[11px] text-gray-400 dark:text-gray-500">
          {lastActivity}
        </span>
      </div>

      <div className="flex items-center gap-1.5 flex-shrink-0">
        <SystemBadge kind="shopify" active={indicators.inShopify} />
        <SystemBadge kind="whaapy" active={indicators.inWhaapy} />
        <ContactTypeBadge isCustomer={isCustomer} />
      </div>
    </Link>
  );
}

function SystemBadge({ kind, active }: { kind: "shopify" | "whaapy"; active: boolean }) {
  if (!active) return null;
  const label = kind === "shopify" ? "Shopify" : "Whaapy";
  return (
    <span
      className={[
        "text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded flex-shrink-0",
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
        "text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded flex-shrink-0",
        isCustomer
          ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300"
          : "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300",
      ].join(" ")}
    >
      {isCustomer ? "Cliente" : "Lead"}
    </span>
  );
}
