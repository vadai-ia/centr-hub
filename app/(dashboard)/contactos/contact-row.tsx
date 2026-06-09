"use client";
import Link from "next/link";
import type { ContactListRow } from "@/lib/db/contacts";
import type { DerivedAdvisor } from "@/lib/db/contacts";
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
  /** Lote polish M6: si el contacto no tiene asesor propio pero
   *  sus opps activas sí, se muestra como derivado. */
  derivedAdvisor?: DerivedAdvisor;
}

/**
 * Fila del listado de Contactos (M6 + lote polish).
 *
 * Lote polish M6:
 *  - Posición fija por dato (grid columns) — no más colapso aleatorio
 *    según cuántos badges existan.
 *  - Asesor derivado visible cuando el contacto no tiene asignación
 *    pero sus opps activas sí (derivación visual; no sobrescribe el
 *    campo en BD — respeta R2).
 *  - Badge "Múltiples" si hay conflicto entre asesores de opps.
 *  - Acento de tipo (lead amber / cliente purple) en la columna de
 *    badges para escaneo rápido.
 */
export function ContactRow({ row, advisors, derivedAdvisor }: Props) {
  const name = contactDisplayName(row);
  const indicators = systemIndicators(row);
  const ownAdvisor = resolveAdvisor(row.assigned_advisor_id, advisors);
  const lastActivity = formatRelative(lastActivityISO(row));
  const isCustomer = row.contactType === "cliente";

  // Asesor a mostrar: si el contacto tiene assigned_advisor_id usamos
  // ese (derecho). Si no, pero hay un derivado único (de opps activas),
  // mostramos ese como "heredado de oportunidad" (derivación visual).
  // Si hay conflicto (varios asesores en sus opps), badge especial.
  const displayAdvisor = row.assigned_advisor_id === null && derivedAdvisor
    ? derivedAdvisor.conflict
      ? null
      : resolveAdvisor(derivedAdvisor.advisorId, advisors)
    : ownAdvisor;
  const advisorIsDerived = row.assigned_advisor_id === null && derivedAdvisor !== undefined && !derivedAdvisor.conflict && derivedAdvisor.advisorId !== null;
  const advisorIsConflict = row.assigned_advisor_id === null && derivedAdvisor?.conflict === true;

  return (
    <Link
      href={`/contactos/${row.id}`}
      className={[
        "grid items-center gap-3 px-4 py-3 border-b border-gray-100 dark:border-gray-700",
        "bg-white dark:bg-gray-800 hover:bg-amber-50/40 dark:hover:bg-amber-500/5 transition-colors",
        "focus:outline-none focus:bg-amber-50 dark:focus:bg-amber-500/10",
        "grid-cols-[1fr] md:grid-cols-[minmax(0,2fr)_140px_160px_120px_100px]",
      ].join(" ")}
    >
      {/* Columna 1: identidad + tel/email */}
      <div className="min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span
            className={[
              "inline-block w-1 h-4 rounded-full flex-shrink-0",
              isCustomer ? "bg-purple-500" : "bg-amber-500",
            ].join(" ")}
            aria-hidden
          />
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
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
          <span className="truncate min-w-0">{row.phone || "—"}</span>
          <span className="truncate hidden lg:inline min-w-0">{row.email || "—"}</span>
          {row.missing_phone && (
            <span className="text-amber-700 dark:text-amber-300 font-medium flex-shrink-0">
              Sin teléfono
            </span>
          )}
        </div>
      </div>

      {/* Columna 2: badges de tipo (fija) */}
      <div className="hidden md:flex items-center gap-1 justify-start">
        <ContactTypeBadge isCustomer={isCustomer} />
      </div>

      {/* Columna 3: presencia en sistemas externos (fija) */}
      <div className="hidden md:flex items-center gap-1 justify-start">
        {row.deleted_in_whaapy ? (
          <span
            className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-medium flex-shrink-0 bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300"
            title="Contacto archivado: eliminado en Whaapy"
          >
            Archivado
          </span>
        ) : (
          <>
            <SystemBadge kind="shopify" active={indicators.inShopify} />
            <SystemBadge kind="whaapy" active={indicators.inWhaapy} />
          </>
        )}
      </div>

      {/* Columna 4: asesor (fija) */}
      <div className="hidden md:flex items-center gap-2 min-w-0">
        {advisorIsConflict ? (
          <span
            className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
            title="Las oportunidades de este contacto están asignadas a asesores distintos. Asigna manualmente al contacto."
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            Múltiples
          </span>
        ) : displayAdvisor ? (
          <>
            <span
              className="inline-block w-2 h-2 rounded-full flex-shrink-0"
              style={{ backgroundColor: displayAdvisor.color }}
              aria-hidden
            />
            <span
              className={[
                "text-xs truncate",
                displayAdvisor.isUnassigned
                  ? "text-amber-700 dark:text-amber-300 italic"
                  : "text-gray-600 dark:text-gray-400",
              ].join(" ")}
              title={advisorIsDerived ? `Heredado de oportunidad — ${displayAdvisor.fullName}` : undefined}
            >
              {displayAdvisor.fullName}
            </span>
            {advisorIsDerived && (
              <span
                className="text-[9px] uppercase tracking-wide font-medium px-1 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300 flex-shrink-0"
                title="Asesor heredado de las oportunidades del contacto"
              >
                Heredado
              </span>
            )}
          </>
        ) : (
          <span className="text-xs italic text-amber-700 dark:text-amber-300">Sin asignar</span>
        )}
      </div>

      {/* Columna 5: última actividad (fija) */}
      <div className="hidden md:flex items-center justify-end">
        <span className="text-[11px] text-gray-400 dark:text-gray-500 whitespace-nowrap">
          {lastActivity}
        </span>
      </div>
    </Link>
  );
}

function SystemBadge({ kind, active }: { kind: "shopify" | "whaapy"; active: boolean }) {
  if (!active) {
    return (
      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-medium opacity-25 bg-gray-100 text-gray-400 dark:bg-gray-700/40 dark:text-gray-500 flex-shrink-0">
        {kind === "shopify" ? "Shopify" : "Whaapy"}
      </span>
    );
  }
  const label = kind === "shopify" ? "Shopify" : "Whaapy";
  return (
    <span
      className={[
        "text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-medium flex-shrink-0",
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
        "text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-medium flex-shrink-0",
        isCustomer
          ? "bg-purple-100 text-purple-700 dark:bg-purple-500/15 dark:text-purple-300"
          : "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
      ].join(" ")}
    >
      {isCustomer ? "Cliente" : "Lead"}
    </span>
  );
}
