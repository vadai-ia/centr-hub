import type { SVGProps } from "react";

/**
 * Íconos de línea del sidebar. Mismo criterio que `kpi-icons.tsx` y
 * `mi-dia-icons.tsx`: SVG inline, trazo 1.8, `currentColor` para heredar
 * el color del link (activo/inactivo). Sin dependencias nuevas — el stack
 * está fijado (CLAUDE.md § "Cambios al stack").
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

/* ── Pestañas generales ─────────────────────────────────────────── */

/** Mi Día — sol. */
function IconSun(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

/** Pipeline — columnas kanban. */
function IconKanban(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="4" width="5" height="12" rx="1.5" />
      <rect x="9.5" y="4" width="5" height="16" rx="1.5" />
      <rect x="16" y="4" width="5" height="8" rx="1.5" />
    </svg>
  );
}

/** Contactos — dos personas. */
function IconUsers(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 20v-1a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v1" />
      <path d="M16 5.5a3.2 3.2 0 0 1 0 6M17.5 14.2A4.6 4.6 0 0 1 21 18.6V20" />
    </svg>
  );
}

/** Whaapy — burbuja de conversación. */
function IconChat(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M20.5 11.5a7.5 7.5 0 0 1-10.9 6.7L4 20l1.8-5.4A7.5 7.5 0 1 1 20.5 11.5z" />
      <path d="M9 11h.01M12 11h.01M15 11h.01" />
    </svg>
  );
}

/** Dashboard — barras. */
function IconChart(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3 20h18" />
      <path d="M6.5 20v-6M11 20V6M15.5 20v-9M20 20v-4" />
    </svg>
  );
}

/* ── Pestañas de administración ─────────────────────────────────── */

/** Etapas del pipeline — capas. */
function IconLayers(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 3 3 7.5 12 12l9-4.5z" />
      <path d="M3 12.5 12 17l9-4.5M3 17 12 21.5 21 17" />
    </svg>
  );
}

/** Motivos de pérdida — círculo con equis. */
function IconXCircle(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5l5 5M14.5 9.5l-5 5" />
    </svg>
  );
}

/** Mapeo de tags — etiqueta. */
function IconTag(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3.5 11.4V4.5a1 1 0 0 1 1-1h6.9a1 1 0 0 1 .7.3l8.1 8.1a1 1 0 0 1 0 1.4l-6.9 6.9a1 1 0 0 1-1.4 0L3.8 12.1a1 1 0 0 1-.3-.7z" />
      <circle cx="7.8" cy="7.8" r="1.3" />
    </svg>
  );
}

/** Reglas — sliders. */
function IconSliders(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 7h16M4 12h16M4 17h16" />
      <circle cx="9" cy="7" r="2" />
      <circle cx="15" cy="12" r="2" />
      <circle cx="8" cy="17" r="2" />
    </svg>
  );
}

/** Metas — diana. */
function IconTarget(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="1" />
    </svg>
  );
}

/** Usuarios — persona con engrane. */
function IconUserCog(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="10" cy="7.5" r="3.3" />
      <path d="M3.5 20v-1a5 5 0 0 1 5-5h3" />
      <circle cx="17.5" cy="17.5" r="2.5" />
      <path d="M17.5 13.6v1M17.5 20.4v1M13.6 17.5h1M20.4 17.5h1" />
    </svg>
  );
}

/** Webhooks de leads — nodos enlazados. */
function IconWebhook(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="6" cy="17.5" r="2.5" />
      <circle cx="18" cy="17.5" r="2.5" />
      <circle cx="12" cy="5" r="2.5" />
      <path d="M10.6 7.1 7.2 15.2M13.4 7.1l3.4 8.1M8.5 17.5h7" />
    </svg>
  );
}

/** Agentes Whaapy — persona con auricular. */
function IconHeadset(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
      <rect x="2.5" y="13.5" width="4" height="6" rx="1.6" />
      <rect x="17.5" y="13.5" width="4" height="6" rx="1.6" />
      <path d="M19.5 19.5v.5a2.5 2.5 0 0 1-2.5 2.5h-2" />
    </svg>
  );
}

/** Integraciones — enchufe. */
function IconPlug(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M9 3v5M15 3v5" />
      <path d="M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6z" />
      <path d="M12 17v4" />
    </svg>
  );
}

/** Organizaciones — edificio. */
function IconBuilding(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 21V5.5a1.5 1.5 0 0 1 1.5-1.5h7A1.5 1.5 0 0 1 14 5.5V21" />
      <path d="M14 10h4.5A1.5 1.5 0 0 1 20 11.5V21M2.5 21h19" />
      <path d="M7 8h4M7 12h4M7 16h4M17 14h.01M17 17.5h.01" />
    </svg>
  );
}

/** Roles y permisos — escudo con check. */
function IconShield(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 3 5 6v5.5c0 4.3 2.9 7.8 7 9.5 4.1-1.7 7-5.2 7-9.5V6z" />
      <path d="M9 12l2.2 2.2L15.5 10" />
    </svg>
  );
}

/** Fallback — punto. Cubre keys de BD sin ícono asignado. */
function IconDot(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="3.5" />
    </svg>
  );
}

/* ── Íconos del propio sidebar (no son pestañas) ────────────────── */

/** Cabecera del grupo Administración — engrane. */
export function IconSettings(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 14a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.5 13H3.2a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.1-2.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10 3.5V3.2a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.3a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.3 1z" />
    </svg>
  );
}

/** Chevron del desplegable. Rota vía clase del consumidor. */
export function IconChevronDown(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M6 9.5 12 15.5 18 9.5" />
    </svg>
  );
}

/**
 * Ícono por key de pestaña. La key es la del `TAB_REGISTRY`
 * (`lib/auth/capabilities.ts`) — que sigue siendo un módulo PURO: el
 * mapeo visual vive aquí, no ahí. Una key sin entrada cae al punto
 * neutro, así que agregar una pestaña nunca rompe el render del sidebar.
 */
const TAB_ICONS: Record<string, (props: IconProps) => JSX.Element> = {
  "mi-dia": IconSun,
  pipeline: IconKanban,
  contactos: IconUsers,
  whaapy: IconChat,
  dashboard: IconChart,
  "admin-etapas": IconLayers,
  "admin-motivos": IconXCircle,
  "admin-mapeo-tags": IconTag,
  "admin-reglas": IconSliders,
  "admin-metas": IconTarget,
  "admin-usuarios": IconUserCog,
  "admin-webhooks": IconWebhook,
  "admin-agentes-whaapy": IconHeadset,
  "admin-integraciones": IconPlug,
  "admin-organizaciones": IconBuilding,
  "admin-roles": IconShield,
};

export function TabIcon({
  tabKey,
  ...props
}: IconProps & { tabKey: string }) {
  const Icon = TAB_ICONS[tabKey] ?? IconDot;
  return <Icon {...props} />;
}
