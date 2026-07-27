/**
 * Badge "Outbound" (Fase 2). Marca visible del origen outbound de un
 * contacto/oportunidad. Se muestra a TODOS los roles (incl. vendedores, que
 * no ven el pipeline Outbound pero sí la marca). Server-safe (sin estado).
 *
 * `compact` (card del kanban): etiqueta corta "Out" a la escala de los demás
 * badges del card, para no alargar el renglón ni competir con el nombre. La
 * lista y el detalle de contacto usan la variante completa ("Outbound"). El
 * `title` conserva el texto completo en ambos casos (accesibilidad — la
 * etiqueta corta no es el único indicador).
 */
export function OutboundBadge({
  className = "",
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    <span
      title="Origen Outbound (trabajado por el SDR)"
      className={[
        compact
          ? "text-[9px] uppercase tracking-wide px-1 py-px rounded font-medium flex-shrink-0"
          : "text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-medium flex-shrink-0",
        "bg-cyan-100 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-300",
        className,
      ].join(" ")}
    >
      {compact ? "Out" : "Outbound"}
    </span>
  );
}
