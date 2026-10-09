"use client";
import {
  ENTRY_CHANNEL_LABELS,
  type ContactJourney,
} from "@/lib/services/contact-journey";

/**
 * Resumen de entrada del cliente (punto 24).
 *
 * Responde "¿dónde está este cliente?" de un vistazo, que es lo que se pidió
 * en la junta — la bitácora de abajo cuenta la historia completa, pero nadie
 * va a leerla cada vez.
 */
export function ContactJourneySummary({ journey }: { journey: ContactJourney }) {
  const diasTexto = (d: number | null, cero: string) => {
    if (d === null) return "—";
    if (d === 0) return cero;
    return d === 1 ? "1 día" : `${d} días`;
  };

  return (
    <section className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
      <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
        Resumen del cliente
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Dato
          titulo="Entró por"
          valor={ENTRY_CHANNEL_LABELS[journey.entryChannel]}
        />
        <Dato
          titulo="Lleva con nosotros"
          valor={diasTexto(journey.daysSinceEntry, "Entró hoy")}
        />
        <Dato
          titulo="Primer avance"
          valor={
            journey.daysToFirstMove === null
              ? "Sin avanzar"
              : diasTexto(journey.daysToFirstMove, "El mismo día")
          }
          /* "Sin avanzar" NO es un hueco de datos: es que la tarjeta sigue
             donde nació. Es justo el dato que delata al lead olvidado. */
          alerta={journey.daysToFirstMove === null && journey.daysSinceEntry > 2}
        />
        <Dato
          titulo="Último movimiento"
          valor={diasTexto(journey.daysSinceLastEvent, "Hoy")}
          alerta={
            journey.daysSinceLastEvent !== null && journey.daysSinceLastEvent > 15
          }
        />
      </dl>
      <p className="mt-3 text-[11px] leading-snug text-gray-400 dark:text-gray-500">
        {journey.messagesSent === 0
          ? "La plataforma no le ha enviado ningún WhatsApp automático."
          : journey.messagesSent === 1
            ? "La plataforma le ha enviado 1 WhatsApp automático."
            : `La plataforma le ha enviado ${journey.messagesSent} WhatsApp automáticos.`}{" "}
        Los mensajes de la conversación se ven en la pestaña de WhatsApp — no
        viven en la plataforma.
      </p>
    </section>
  );
}

function Dato({
  titulo,
  valor,
  alerta = false,
}: {
  titulo: string;
  valor: string;
  alerta?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-gray-400 dark:text-gray-500">
        {titulo}
      </dt>
      <dd
        className={`mt-0.5 truncate text-sm font-medium ${
          alerta
            ? "text-amber-700 dark:text-amber-300"
            : "text-gray-800 dark:text-gray-100"
        }`}
        title={valor}
      >
        {valor}
      </dd>
    </div>
  );
}
