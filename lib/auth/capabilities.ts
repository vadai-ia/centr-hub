/**
 * Modelo de permisos de DOS EJES (feature "Roles configurables").
 *
 * NO es server-only: lo consumen tanto Server Components/actions como
 * el Client Component del sidebar. Es un módulo PURO (sin acceso a BD ni
 * a sesión) — recibe las capacidades ya resueltas y responde preguntas.
 *
 * Eje A — QUÉ PESTAÑAS ve el rol  → `allowedTabs` (keys del TAB_REGISTRY).
 * Eje B — QUÉ DATOS alcanza       → `dataScope` ('own' | 'all').
 *
 * "Ver es operar": no hay un tercer eje por-acción. Si un rol ve una
 * pestaña general, opera en ella con su alcance de datos. Las capacidades
 * operativas que antes gateaban en `isAdmin` (reasignar, ver sin asignar,
 * breakdown por vendedor, etc.) se derivan de `canSeeAllData` — así el
 * vendedor (own) conserva su comportamiento exacto y el SDR/admin (all)
 * operan sobre toda la org.
 */

export type DataScope = "own" | "all";

export type TabSection = "general" | "admin";

export interface TabDef {
  /** Key estable — coincide con `roles.allowed_tabs` en BD. */
  key: string;
  /** Etiqueta visible (español). */
  label: string;
  /** Ruta de la pestaña. */
  href: string;
  section: TabSection;
}

/**
 * Registro único de pestañas. Las keys DEBEN coincidir 1:1 con las
 * sembradas en la migración 0039 (`roles.allowed_tabs`). El orden aquí
 * es el orden de render en el sidebar.
 */
export const TAB_REGISTRY: readonly TabDef[] = [
  // Generales — visibles según el rol.
  { key: "mi-dia", label: "Mi Día", href: "/mi-dia", section: "general" },
  { key: "pipeline", label: "Pipeline", href: "/pipeline", section: "general" },
  { key: "contactos", label: "Contactos", href: "/contactos", section: "general" },
  { key: "whaapy", label: "Whaapy", href: "/whaapy", section: "general" },
  { key: "dashboard", label: "Dashboard", href: "/dashboard", section: "general" },
  // Administración.
  { key: "admin-etapas", label: "Etapas del pipeline", href: "/admin/etapas", section: "admin" },
  { key: "admin-motivos", label: "Motivos de pérdida", href: "/admin/motivos", section: "admin" },
  { key: "admin-mapeo-tags", label: "Mapeo de tags", href: "/admin/mapeo-tags", section: "admin" },
  { key: "admin-reglas", label: "Reglas", href: "/admin/reglas", section: "admin" },
  { key: "admin-metas", label: "Metas", href: "/admin/metas", section: "admin" },
  { key: "admin-usuarios", label: "Usuarios", href: "/admin/usuarios", section: "admin" },
  { key: "admin-webhooks", label: "Webhooks de leads", href: "/admin/webhooks", section: "admin" },
  { key: "admin-agentes-whaapy", label: "Agentes Whaapy", href: "/admin/agentes-whaapy", section: "admin" },
  { key: "admin-integraciones", label: "Integraciones", href: "/admin/integraciones", section: "admin" },
  { key: "admin-organizaciones", label: "Organizaciones", href: "/admin/organizaciones", section: "admin" },
  { key: "admin-roles", label: "Roles y permisos", href: "/admin/roles", section: "admin" },
] as const;

export const GENERAL_TAB_KEYS: readonly string[] = TAB_REGISTRY.filter(
  (t) => t.section === "general",
).map((t) => t.key);

export const ADMIN_TAB_KEYS: readonly string[] = TAB_REGISTRY.filter(
  (t) => t.section === "admin",
).map((t) => t.key);

export const ALL_TAB_KEYS: readonly string[] = TAB_REGISTRY.map((t) => t.key);

/** Roles de sistema — protegidos de borrado y de quedar sin pestañas (0039). */
export const SYSTEM_ROLE_KEYS = ["superadmin", "admin", "vendedor"] as const;

/**
 * Key del rol de Customer Success (0047). NO es un rol de sistema (se crea
 * desde Admin → Roles), pero su `key` es el ancla estable que cablea la
 * segunda ranura de asignación de Post-venta
 * (`opportunities.customer_success_membership_id`), igual que `'vendedor'`
 * cablea la de asesor.
 *
 * Vive aquí (módulo PURO) para que lo compartan el Client Component que
 * decide si pinta el selector y la capa de datos que lista los elegibles.
 * El mismo string está hardcodeado en la migración 0047 (función
 * `default_customer_success_membership_id` y su trigger): cambiarlo de un
 * solo lado desconecta la feature en silencio.
 */
export const CUSTOMER_SUCCESS_ROLE_KEY = "customer-success" as const;

/**
 * Capacidades resueltas de un rol (proyección de la fila `roles`).
 * Es lo que se cuelga de la sesión y lo que reciben los helpers.
 */
export interface RoleCapabilities {
  /** `roles.key` — también el valor de `memberships.role`. */
  key: string;
  /** `roles.label` — nombre visible. */
  label: string;
  dataScope: DataScope;
  allowedTabs: readonly string[];
  isSystem: boolean;
}

export function isAdminTab(tabKey: string): boolean {
  return ADMIN_TAB_KEYS.includes(tabKey);
}

/** ¿El rol ve esta pestaña? (visibilidad de nav + gate de ruta/acción). */
export function hasTab(caps: RoleCapabilities, tabKey: string): boolean {
  return caps.allowedTabs.includes(tabKey);
}

/**
 * ¿El rol alcanza TODOS los datos de la org? (data_scope='all').
 * Reemplaza al viejo `isAdmin` en todo lo que era alcance de datos u
 * operación sobre pestañas generales (reasignar, ver sin asignar, etc.).
 * true para admin/superadmin y SDR; false para vendedor.
 */
export function canSeeAllData(caps: RoleCapabilities): boolean {
  return caps.dataScope === "all";
}

/**
 * ¿El rol puede designar al Customer Success de una oportunidad de
 * Post-venta? (0047). Los roles con alcance de datos completo
 * (admin/superadmin/SDR) y el propio Customer Success. Un vendedor lo VE
 * pero no lo cambia.
 */
export function canAssignCustomerSuccess(caps: RoleCapabilities): boolean {
  return canSeeAllData(caps) || caps.key === CUSTOMER_SUCCESS_ROLE_KEY;
}

/** ¿El rol tiene acceso a ALGUNA pestaña de Administración? */
export function canAccessAdminPanel(caps: RoleCapabilities): boolean {
  return caps.allowedTabs.some((t) => isAdminTab(t));
}

/** Pestañas visibles del rol, en el orden del registro. */
export function visibleTabs(caps: RoleCapabilities): TabDef[] {
  return TAB_REGISTRY.filter((t) => caps.allowedTabs.includes(t.key));
}

/**
 * Ruta de aterrizaje del rol: su primera pestaña visible (generales antes
 * que admin, por el orden del registro). Fallback defensivo a "/no-access"
 * si el rol quedara sin pestañas (la app impide guardar un rol así).
 */
export function landingHref(caps: RoleCapabilities): string {
  const first = visibleTabs(caps)[0];
  return first ? first.href : "/no-access";
}

/**
 * Fallback defensivo: si por algún motivo no se encontró la fila `roles`
 * (no debería pasar — la migración 0039 siembra los de sistema y el FK
 * garantiza que exista), derivar capacidades mínimas seguras desde la key.
 * NUNCA otorga admin por defecto salvo a admin/superadmin conocidos.
 */
export function fallbackCapabilities(roleKey: string): RoleCapabilities {
  if (roleKey === "admin" || roleKey === "superadmin") {
    return {
      key: roleKey,
      label: roleKey === "superadmin" ? "Superadmin" : "Administrador",
      dataScope: "all",
      allowedTabs: ALL_TAB_KEYS,
      isSystem: true,
    };
  }
  // vendedor y cualquier rol desconocido → mínimo seguro: pestañas
  // generales, solo datos propios, sin panel de administración.
  return {
    key: roleKey,
    label: roleKey === "vendedor" ? "Vendedor" : roleKey,
    dataScope: "own",
    allowedTabs: GENERAL_TAB_KEYS,
    isSystem: roleKey === "vendedor",
  };
}
