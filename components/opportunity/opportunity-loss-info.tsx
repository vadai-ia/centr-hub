"use client";
import type { LossReasonRow, OpportunityRow } from "@/lib/types/database";

interface Props {
  opportunity: OpportunityRow;
  lossReason: LossReasonRow | null;
}

/**
 * Bloque de información de pérdida (M6 — B4).
 *
 * Mostrado solo cuando la opp está en etapa `is_lost`. Combina el
 * motivo (`loss_reasons.name`) con la nota libre (`opportunity.note`,
 * persistida por el move-service de M5 en el mismo update que
 * transitó la opp a Perdida).
 *
 * Diseño: bloque rojo discreto que destaque visualmente sin gritar.
 */
export function OpportunityLossInfo({ opportunity, lossReason }: Props) {
  return (
    <section className="bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-900/40 rounded-md p-4">
      <h3 className="text-sm font-semibold text-red-800 dark:text-red-200">
        Oportunidad perdida
      </h3>
      <dl className="mt-2 space-y-1.5 text-sm">
        <div className="flex gap-2">
          <dt className="text-red-700 dark:text-red-300 font-medium">Motivo:</dt>
          <dd className="text-red-900 dark:text-red-100">
            {lossReason?.name ?? "Sin motivo registrado"}
          </dd>
        </div>
        {opportunity.note && (
          <div>
            <dt className="text-red-700 dark:text-red-300 font-medium">Notas del asesor:</dt>
            <dd className="text-red-900 dark:text-red-100 mt-0.5 whitespace-pre-wrap">
              {opportunity.note}
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}
