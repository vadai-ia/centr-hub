import { InfoTooltip } from "./info-tooltip";
import { formatCount, formatPercent } from "@/lib/format/dashboard";
import type { LeadFunnel } from "@/lib/types/dashboard";

const TOOLTIP =
  "De las PERSONAS que entraron como lead en el periodo, hasta dónde llegó cada una. " +
  "Se cuenta por persona y no por oportunidad porque el lead vive en una tarjeta y la venta " +
  "se cierra en otra (la de la cotización de Shopify). Cada renglón es 'llegó al menos a esta " +
  "etapa', así que una tarjeta que saltó de Lead nuevo a Cotización cuenta en los pasos " +
  "intermedios. El embudo termina en Ganada: las etapas posteriores (Cold) son salidas, no " +
  "avance. Perdida no es un paso del embudo — se ve en la caída entre renglones. " +
  "El último renglón NO es el KPI de Ganadas: ahí entran todas las ventas cerradas en el " +
  "periodo, vengan de donde vengan; aquí solo las de ESTOS leads, y una venta que cierre el " +
  "mes que viene todavía no aparece.";

/**
 * Embudo de leads (punto 9 de la junta): "rastreo de leads → calificados →
 * ganados", que antes no existía en ninguna pantalla.
 *
 * Se lee de arriba abajo: el primer renglón son todos los leads del periodo y
 * cada barra es la proporción que llegó hasta ahí. La columna "pasa" es la
 * conversión de un renglón al siguiente — es ahí donde se ve dónde se cae el
 * embudo, que es la pregunta real.
 */
export function LeadFunnelCard({ funnel }: { funnel: LeadFunnel }) {
  const top = funnel.steps[0]?.reached ?? 0;

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-sm">
      <div className="mb-1 flex items-center gap-1 text-sm font-medium text-gray-700 dark:text-gray-200">
        Embudo de leads
        <InfoTooltip label="Embudo de leads" content={TOOLTIP} />
      </div>

      {funnel.cohortSize === 0 ? (
        <div className="h-56 flex items-center justify-center text-sm text-gray-400 dark:text-gray-500">
          No entraron leads en el periodo
        </div>
      ) : (
        <>
          <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
            {formatCount(funnel.cohortSize)} personas
            {funnel.leadOpportunities !== funnel.cohortSize && (
              <>
                {" "}
                ({formatCount(funnel.leadOpportunities)} entradas — alguien entró
                como lead más de una vez)
              </>
            )}
          </p>

          <ul className="space-y-1.5">
            {funnel.steps.map((s, i) => {
              const width = top > 0 ? Math.max((s.reached / top) * 100, 1.5) : 0;
              const dropped = i === 0 ? 0 : funnel.steps[i - 1]!.reached - s.reached;
              return (
                <li key={s.stageId}>
                  <div className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="truncate text-gray-600 dark:text-gray-300">
                      {s.stageName}
                    </span>
                    <span className="shrink-0 tabular-nums text-gray-500 dark:text-gray-400">
                      <span className="font-medium text-gray-800 dark:text-gray-100">
                        {formatCount(s.reached)}
                      </span>{" "}
                      · {formatPercent(s.shareOfLeads)}
                      {s.stepConversion !== null && (
                        <span
                          className="ml-1.5 text-gray-400 dark:text-gray-500"
                          title={`Pasó ${formatPercent(s.stepConversion)} del paso anterior${
                            dropped > 0 ? ` (se quedaron ${formatCount(dropped)})` : ""
                          }`}
                        >
                          ({formatPercent(s.stepConversion)} pasa)
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="mt-0.5 h-2 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700/60">
                    <div
                      className="h-full rounded-full bg-indigo-500/80 dark:bg-indigo-400/70"
                      style={{ width: `${width}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>

          {/* El tablero muestra "Ganadas" (todas las del periodo) justo
              arriba; el embudo cierra en un número mucho menor y sin esta
              línea se lee como que los datos no cuadran. Es la queja que ya
              existe sobre el dashboard — no hay que sembrarla de nuevo. */}
          <p className="mt-3 text-[11px] leading-snug text-gray-400 dark:text-gray-500">
            El cierre del embudo cuenta solo las ventas de estos leads. El KPI de
            Ganadas cuenta todas las del periodo, incluidas las de leads que
            entraron antes — por eso es mayor.
          </p>

          {funnel.parked > 0 && (
            <p className="mt-1.5 text-[11px] text-gray-400 dark:text-gray-500">
              {formatCount(funnel.parked)}{" "}
              {funnel.parked === 1 ? "persona salió" : "personas salieron"} a una
              etapa posterior al cierre (Cold). No cuentan como avance.
            </p>
          )}
        </>
      )}
    </div>
  );
}
