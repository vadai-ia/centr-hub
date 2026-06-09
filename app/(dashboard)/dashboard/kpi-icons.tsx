import type { SVGProps } from "react";

/**
 * Íconos de línea para las tarjetas KPI hero (M8.2 rediseño). Set
 * mínimo, trazo consistente (1.8), `currentColor` para heredar el color
 * semántico del chip. Sin dependencias nuevas.
 */
type IconProps = SVGProps<SVGSVGElement>;

function base(props: IconProps) {
  return {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    ...props,
  };
}

/** Revenue / ingreso — billete. */
export function IconRevenue(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6 9v6M18 9v6" />
    </svg>
  );
}

/** Pipeline / embudo. */
export function IconPipeline(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3 5h18l-7 8v6l-4-2v-4z" />
    </svg>
  );
}

/** Win rate / cierre — trofeo. */
export function IconTrophy(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M7 4h10v4a5 5 0 0 1-10 0z" />
      <path d="M7 5H4v1a3 3 0 0 0 3 3M17 5h3v1a3 3 0 0 1-3 3" />
      <path d="M10 13v3h4v-3M8 20h8M9 20v-1.5h6V20" />
    </svg>
  );
}

/** Ganadas — check en círculo. */
export function IconCheck(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 12.5l2.5 2.5 4.5-5" />
    </svg>
  );
}

/** Pedidos — caja. */
export function IconBox(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z" />
      <path d="M3.5 7.5 12 12l8.5-4.5M12 12v9" />
    </svg>
  );
}

/** Activos ahora — pulso. */
export function IconPulse(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3 12h4l2-6 4 12 2-6h6" />
    </svg>
  );
}

/** Casos problemáticos — alerta. */
export function IconAlert(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 4 2.5 20h19z" />
      <path d="M12 10v4M12 17h.01" />
    </svg>
  );
}
