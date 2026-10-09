import { InfoTooltip } from "./info-tooltip";
import { formatCount, formatPercent } from "@/lib/format/dashboard";
import { formatElapsed } from "@/lib/services/lead-timings";
import { ENTRY_CHANNEL_LABELS } from "@/lib/services/contact-journey";
import type { LeadTimings } from "@/lib/types/dashboard";

const TOOLTIP =
  "De las MISMAS personas que cuenta el embudo: cuánto tardó el primer avance de etapa " +
  "y por dónde entraron. Se mide del momento en que entró el lead al primer movimiento " +
  "posterior — la tarjeta aterrizando en su etapa inicial no cuenta como avance, porque " +
  "ocurre en el mismo instante en que entró. Se muestra la mediana: el promedio lo " +
  "arrastra un lead olvidado y hace parecer lento a todo el equipo. 'Sin avanzar' son los " +
  "que siguen donde nacieron. El canal sale de la bitácora del cliente, no de qué " +
  "sistemas tiene ligados: un lead de WhatsApp adquiere identidad de Shopify en cuanto " +
  "alguien le cotiza.";

/**
 * Tiempos y origen (punto 24, segunda mitad).
 *
 * El embudo dice DÓNDE se cae el proceso; esto dice CUÁNTO tarda y POR DÓNDE
 * entra la gente — las dos preguntas que la dirección pidió poder contestar
 * "basado en lo sucedido con cada uno de los clientes".
 */
export function LeadTimingsCard({ timings }: { timings: LeadTimings }) {
  const top = timings.byChannel[0]?.count ?? 0;

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-1 text-sm font-medium text-gray-700 dark:text-gray-200">
        Tiempos y origen
        <InfoTooltip label="Tiempos y origen" content={TOOLTIP} />
      </div>

      {timings.cohortSize === 0 ? (
        <div className="h-56 flex items-center justify-center text-sm text-gray-400 dark:text-gray-500">
          No entraron leads en el periodo
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Metrica
              titulo="Primer avance"
              valor={formatElapsed(timings.medianHoursToFirstMove)}
              nota={
                timings.movedCount > 0
                  ? `mediana de ${formatCount(timings.movedCount)}`
                  : "sin datos"
              }
            />
            <Metrica
              titulo="Promedio"
              valor={formatElapsed(timings.averageHoursToFirstMove)}
              nota="arrastrado por los lentos"
            />
            <Metrica
              titulo="Sin avanzar"
              valor={formatCount(timings.withoutMove)}
              nota={`de ${formatCount(timings.cohortSize)}`}
              alerta={timings.withoutMove > 0}
            />
          </div>

          <p className="mt-4 mb-2 text-xs font-medium text-gray-600 dark:text-gray-300">
            Por dónde entraron
          </p>
          <ul className="space-y-1.5">
            {timings.byChannel.map((c) => (
              <li key={c.channel}>
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="truncate text-gray-600 dark:text-gray-300">
                    {ENTRY_CHANNEL_LABELS[c.channel]}
                  </span>
                  <span className="shrink-0 tabular-nums text-gray-500 dark:text-gray-400">
                    <span className="font-medium text-gray-800 dark:text-gray-100">
                      {formatCount(c.count)}
                    </span>{" "}
                    · {formatPercent(c.share)}
                  </span>
                </div>
                <div className="mt-0.5 h-2 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700/60">
                  <div
                    className="h-full rounded-full bg-sky-500/80 dark:bg-sky-400/70"
                    style={{
                      width: `${top > 0 ? Math.max((c.count / top) * 100, 1.5) : 0}%`,
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>

          {timings.byChannel.some((c) => c.channel === "desconocido") && (
            <p className="mt-3 text-[11px] leading-snug text-gray-400 dark:text-gray-500">
              &quot;Sin determinar&quot; son los que entraron antes de que la
              plataforma registrara el origen. No se infiere de los sistemas que
              tienen ligados: diría Shopify de casi todos.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Metrica({
  titulo,
  valor,
  nota,
  alerta = false,
}: {
  titulo: string;
  valor: string;
  nota: string;
  alerta?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-lg bg-gray-50 dark:bg-gray-700/40 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-gray-400 dark:text-gray-500">
        {titulo}
      </p>
      <p
        className={`mt-0.5 truncate text-sm font-semibold ${
          alerta
            ? "text-amber-700 dark:text-amber-300"
            : "text-gray-800 dark:text-gray-100"
        }`}
      >
        {valor}
      </p>
      <p className="text-[10px] text-gray-400 dark:text-gray-500">{nota}</p>
    </div>
  );
}
