"use client";
import { useEffect, useRef } from "react";
import type { KanbanOpportunity } from "@/lib/db/opportunities";
import type { AdvisorOption } from "@/lib/types/pipeline";
import type { PipelineStageRow } from "@/lib/types/database";
import {
  contactDisplayName,
  contactIsCustomer,
  deriveDisplayAmount,
  formatAmount,
  resolveAdvisor,
} from "./utils";

interface Props {
  opp: KanbanOpportunity | null;
  stage: PipelineStageRow | null;
  advisors: AdvisorOption[];
  onClose: () => void;
}

/**
 * Popup de quick-view (M5).
 *
 * Solo lectura, sin entrada al detalle completo (M6 lo decide
 * cuando se construya). ESC + click fuera lo cierran. Los datos
 * vienen ya cargados en `opp` para evitar fetch adicional
 * (regla del prompt M5).
 *
 * Diseño funcional, F7 itera estética.
 */
export function QuickView({ opp, stage, advisors, onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!opp) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [opp, onClose]);

  // Focus management: foco al panel al abrir, restaura al cerrar.
  useEffect(() => {
    if (!opp) return;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previous?.focus?.();
  }, [opp]);

  if (!opp) return null;

  const contact = opp.contact;
  const name = contactDisplayName(contact);
  const isCustomer = contactIsCustomer(contact);
  const amountDisplay = deriveDisplayAmount(opp);
  const actualMxn = formatAmount(opp.actual_amount, opp.currency);
  const estimatedMxn = formatAmount(opp.estimated_amount, opp.currency);
  const advisor = resolveAdvisor(opp.assigned_advisor_id, advisors);
  const lastModified = formatLastModified(opp.last_modified_at);
  const tags = contact?.shopify_tags ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-gray-900/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="quickview-title"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-lg w-full p-6 outline-none"
      >
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="min-w-0 flex-1">
            <p
              id="quickview-title"
              className="text-lg font-semibold text-gray-900 dark:text-gray-100 truncate"
            >
              {name}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {isCustomer ? "Cliente" : "Lead"}
              {stage ? ` · ${stage.name}` : ""}
              {opp.display_reference ? ` · ${opp.display_reference}` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          >
            ✕
          </button>
        </div>

        <dl className="space-y-3 text-sm">
          {contact?.phone && (
            <Row label="Teléfono" value={contact.phone} />
          )}
          {contact?.email && (
            <Row label="Email" value={contact.email} />
          )}
          <Row
            label="Monto"
            value={
              actualMxn || estimatedMxn ? (
                <>
                  {actualMxn ? (
                    <span className="text-gray-900 dark:text-gray-100">
                      Real: {actualMxn}
                    </span>
                  ) : null}
                  {actualMxn && estimatedMxn ? " · " : ""}
                  {estimatedMxn ? (
                    <span className="text-amber-700 dark:text-amber-300">
                      Estimado: {estimatedMxn}
                    </span>
                  ) : null}
                </>
              ) : (
                <span className="text-gray-400 italic">{amountDisplay.text}</span>
              )
            }
          />
          <Row
            label="Asesor"
            value={
              <span className="flex items-center gap-2">
                <span
                  className="inline-block w-2 h-2 rounded-full"
                  style={{ backgroundColor: advisor.color }}
                  aria-hidden
                />
                <span
                  className={
                    advisor.isUnassigned
                      ? "text-amber-700 dark:text-amber-300 italic"
                      : ""
                  }
                >
                  {advisor.fullName}
                </span>
              </span>
            }
          />
          {tags.length > 0 && (
            <Row
              label="Tags Shopify"
              value={
                <div className="flex flex-wrap gap-1">
                  {tags.map((t) => (
                    <span
                      key={t}
                      className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              }
            />
          )}
          {lastModified && (
            <Row label="Última modificación" value={lastModified} />
          )}
        </dl>

        <p className="mt-6 text-xs text-gray-400 dark:text-gray-500">
          Vista rápida. El detalle completo llegará en una siguiente versión.
        </p>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[8rem_1fr] items-start gap-3">
      <dt className="text-xs uppercase tracking-wide text-gray-400 dark:text-gray-500 mt-0.5">
        {label}
      </dt>
      <dd className="text-gray-700 dark:text-gray-200 break-words">{value}</dd>
    </div>
  );
}

function formatLastModified(iso: string): string | null {
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return null;
    return new Intl.DateTimeFormat("es-MX", {
      timeZone: "America/Mexico_City",
      dateStyle: "medium",
      timeStyle: "short",
    }).format(d);
  } catch {
    return null;
  }
}
