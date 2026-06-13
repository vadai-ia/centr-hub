/**
 * Íconos de línea (stroke) propios de Mi Día. SVG inline, sin dependencias
 * (CLAUDE.md prohíbe instalar libs de UI). 1.75 de stroke, currentColor,
 * para que hereden el color del chip que los contiene.
 */
type IconProps = { className?: string };

const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function IconAlert({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

export function IconSun({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

export function IconCoins({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <ellipse cx="9" cy="6" rx="6" ry="3" />
      <path d="M3 6v6c0 1.66 2.69 3 6 3s6-1.34 6-3V6" />
      <path d="M3 12v6c0 1.66 2.69 3 6 3 1.1 0 2.13-.15 3-.4" />
      <path d="M15 8.5c2.36.37 4 1.4 4 2.5 0 1.1-1.64 2.13-4 2.5" />
      <path d="M21 11.5v6c0 1.5-2.2 2.74-5 2.97" />
    </svg>
  );
}

export function IconCheck({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

export function IconBell({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

export function IconFlame({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <path d="M12 2c0 3-3 4.5-3 8a3 3 0 0 0 6 0c0-1 .5-2 1-2.5C16.5 10 18 12 18 15a6 6 0 0 1-12 0c0-5 6-7 6-13Z" />
    </svg>
  );
}

export function IconBolt({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

export function IconClock({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15 14" />
    </svg>
  );
}
