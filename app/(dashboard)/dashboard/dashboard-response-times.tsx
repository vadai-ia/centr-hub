import { InfoTooltip } from "./info-tooltip";
import { formatCount } from "@/lib/format/dashboard";
import { formatMinutes } from "@/lib/services/response-times";
import type {
  AdvisorBreakdownRow,
  ResponseTimes,
} from "@/lib/types/dashboard";

const TOOLTIP =
  "Cuánto tarda el equipo en contestar por WhatsApp. Se mide del mensaje del cliente " +
  "a la primera respuesta de una PERSONA: las respuestas del agente de IA de Whaapy no " +
  "cuentan, porque contesta en segundos y dejaría a todos con respuesta instantánea. " +
  "Varios mensajes seguidos del cliente son una sola espera. No es lo mismo que el " +
  "primer avance de etapa: un asesor puede contestar en dos minutos y no tocar la " +
  "tarjeta en dos días. 'Sin contestar' son los clientes que escribieron y nadie " +
  "respondió dentro del periodo.";

/**
 * Tiempo de respuesta del asesor (0058).
 *
 * La dirección preguntó "¿cuánto tarda cada comercial en contestar?". Hasta
 * ahora el dashboard solo sabía decir cuánto tardaba en MOVER la tarjeta,
 * que es otra cosa — y por eso esta tarjeta va junto a "Tiempos y origen",
 * para que la diferencia se vea de un vistazo en lugar de confundirse.
 */
export function ResponseTimesCard({
  times,
  breakdown,
  measuringSince,
}: {
  times: ResponseTimes;
  /** Para poner nombre a cada asesor. null = quien mira es un vendedor. */
  breakdown: AdvisorBreakdownRow[] | null;
  /** Desde cuándo hay mensajes registrados. La tabla arranca vacía. */
  measuringSince: string | null;
}) {
  const nombres = new Map(
    (breakdown ?? []).map((r) => [r.membershipId ?? "", r.name]),
  );
  // Solo tiene sentido desglosar cuando se ve a varias personas. Un vendedor
  // vería una sola fila con su propio nombre, repitiendo la cifra de arriba.
  const filas = breakdown ? times.byAdvisor : [];
  const tope = filas[0]?.medianMinutes ?? null;

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-1 text-sm font-medium text-gray-700 dark:text-gray-200">
        Tiempo de respuesta
        <InfoTooltip label="Tiempo de respuesta" content={TOOLTIP} />
      </div>

      {times.responses === 0 && times.unanswered === 0 ? (
        <div className="flex h-56 flex-col items-center justify-center gap-1 px-4 text-center text-sm text-gray-400 dark:text-gray-500">
          <span>No hay conversaciones registradas en el periodo</span>
          {measuringSince === null && (
            <span className="text-xs">
              Los mensajes se empiezan a registrar desde que se conectó WhatsApp
              — no hay forma de reconstruir los anteriores.
            </span>
          )}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Metrica
              titulo="Primera respuesta"
              valor={formatMinutes(times.medianMinutes)}
              nota={
                times.responses > 0
                  ? `mediana de ${formatCount(times.responses)}`
                  : "sin datos"
              }
            />
            <Metrica
              titulo="Promedio"
              valor={formatMinutes(times.averageMinutes)}
              nota="arrastrado por los lentos"
            />
            <Metrica
              titulo="Sin contestar"
              valor={formatCount(times.unanswered)}
              nota="nadie respondió"
              alerta={times.unanswered > 0}
            />
          </div>

          {filas.length > 0 && (
            <>
              <p className="mt-4 mb-2 text-xs font-medium text-gray-600 dark:text-gray-300">
                Por asesor
              </p>
              <ul className="space-y-1.5">
                {filas.map((f) => {
                  const key = f.advisorMembershipId ?? "";
                  return (
                    <li key={key}>
                      <div className="flex items-baseline justify-between gap-2 text-xs">
                        <span className="truncate text-gray-600 dark:text-gray-300">
                          {nombres.get(key) ?? "Sin asesor"}
                        </span>
                        <span className="shrink-0 tabular-nums text-gray-500 dark:text-gray-400">
                          <span className="font-medium text-gray-800 dark:text-gray-100">
                            {formatMinutes(f.medianMinutes)}
                          </span>{" "}
                          · {formatCount(f.responses)}
                        </span>
                      </div>
                      <div className="mt-0.5 h-2 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700/60">
                        <div
                          className="h-full rounded-full bg-violet-500/80 dark:bg-violet-400/70"
                          style={{
                            // Barra RELATIVA al más lento, no a un objetivo:
                            // no hay tiempo de respuesta acordado contra el
                            // que medir, así que un semáforo inventaría una
                            // meta que nadie fijó.
                            width: `${barra(f.medianMinutes, filas)}%`,
                          }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
              {tope !== null && (
                <p className="mt-3 text-[11px] leading-snug text-gray-400 dark:text-gray-500">
                  Ordenado del más rápido al más lento. La barra compara entre
                  ellos: no hay un tiempo de respuesta acordado contra el cual
                  medir.
                </p>
              )}
            </>
          )}

          {measuringSince !== null && (
            <p className="mt-2 text-[11px] leading-snug text-gray-400 dark:text-gray-500">
              Se mide desde {measuringSince}: antes de esa fecha la plataforma
              no recibía los mensajes.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** Proporción contra el PEOR del grupo, para que la barra tenga escala. */
function barra(
  minutes: number | null,
  filas: ResponseTimes["byAdvisor"],
): number {
  if (minutes === null) return 0;
  const peor = Math.max(...filas.map((f) => f.medianMinutes ?? 0));
  if (peor <= 0) return 1.5;
  return Math.max((minutes / peor) * 100, 1.5);
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
