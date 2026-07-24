/**
 * Badge "Outbound" (Fase 2). Marca visible del origen outbound de un
 * contacto/oportunidad. Se muestra a TODOS los roles (incl. vendedores, que
 * no ven el pipeline Outbound pero sí la marca). Server-safe (sin estado).
 */
export function OutboundBadge({ className = "" }: { className?: string }) {
  return (
    <span
      title="Origen Outbound (trabajado por el SDR)"
      className={[
        "text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-medium flex-shrink-0",
        "bg-cyan-100 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-300",
        className,
      ].join(" ")}
    >
      Outbound
    </span>
  );
}
