import type {
  DataScope,
  LossReasonRow,
  PipelineStageRow,
  TagClassification,
  UUID,
} from "@/lib/types/database";
import type { StageAutomationInfo } from "@/lib/services/stage-automation";

export type { StageAutomationInfo };

/**
 * Tipos compartidos de las pantallas de administración (M7.2) entre
 * server actions y UI. Vive aquí porque los archivos `"use server"`
 * solo pueden exportar funciones async — los tipos compartidos deben
 * venir de otro módulo.
 */

/**
 * Etapa enriquecida para el panel admin: la fila + su dependencia de
 * automatizaciones (para badges + advertencias en editar/borrar).
 */
export interface StageAdminView extends PipelineStageRow {
  automation: StageAutomationInfo;
}

/** Qué pasó al confirmar la eliminación de una etapa (Bloque A). */
export type StageDeletionOutcome = "deleted" | "deactivated" | "reactivated";

export type StageActionResult =
  | { ok: true; stages: StageAdminView[]; outcome?: StageDeletionOutcome }
  | { ok: false; message: string };

/**
 * Plan de eliminación de una etapa, resuelto en servidor al abrir el
 * diálogo (Bloque A). El cliente lo usa para mostrar el diálogo correcto:
 *   - "delete"       → borrado real (sin historial ni oportunidades).
 *   - "deactivate"   → tiene historial inmutable → se archiva (desactiva),
 *                      no se puede borrar en duro.
 *   - "blocked"      → tiene oportunidades vivas dentro → mover primero.
 */
export interface StageDeletionPlan {
  action: "delete" | "deactivate" | "blocked";
  /** Oportunidades (incluidas canceladas) actualmente en la etapa. */
  opportunityCount: number;
  /** true si existe historial que impide el borrado en duro. */
  hasHistory: boolean;
  automation: StageAutomationInfo;
}

export type StageDeletionPlanResult =
  | { ok: true; plan: StageDeletionPlan }
  | { ok: false; message: string };

export type LossReasonActionResult =
  | { ok: true; reasons: LossReasonRow[] }
  | { ok: false; message: string };

/** Fila del listado de mapeo de tags (M7.2, Bloque 5). */
export interface TagMappingView {
  normalized: string;
  original: string;
  /** Entidades (contactos + órdenes) que llevan la tag. */
  count: number;
  classification: TagClassification;
  mapped_membership_id: UUID | null;
  /** Nombre del vendedor mapeado (null si informativa o sin resolver). */
  mapped_vendor_name: string | null;
  /** false → vendedor desactivado (mapeo inactivo). null si no aplica. */
  mapped_vendor_active: boolean | null;
}

export interface TagVendorOption {
  membershipId: UUID;
  fullName: string;
  isActive: boolean;
}

export type TagMappingActionResult =
  | { ok: true; mappings: TagMappingView[] }
  | { ok: false; message: string };

export type TagReprocessResult =
  | { ok: true; mode: "inline" | "background" | "none"; count: number }
  | { ok: false; message: string };

// ============================================================
// Gestión de usuarios (M9.2)
// ============================================================

/**
 * Estado del login de un usuario gestionable:
 *   - "active": auth cargó y el usuario ya inició sesión alguna vez.
 *   - "pending": invitado (auth con email) pero nunca aceptó/accedió.
 *   - "placeholder": fila de auth.users insertada por SQL crudo que
 *     GoTrue no puede cargar (Gina/Pepe pre-M9.2) — necesita "vincular
 *     login" (Block 2, repair-in-place). Sin email recuperable aún.
 */
export type UserLoginStatus = "active" | "pending" | "placeholder";

/** Opción de rol asignable en la UI (invitar / editar) — 0039. */
export interface RoleOption {
  key: string;
  label: string;
  isSystem: boolean;
  dataScope: DataScope;
}

/** Fila del constructor de roles (Admin → Roles y permisos, 0039). */
export interface RoleAdminView {
  id: UUID;
  key: string;
  label: string;
  dataScope: DataScope;
  allowedTabs: string[];
  isSystem: boolean;
  /** Usuarios (activos + inactivos) que usan este rol — bloquea borrado si > 0. */
  userCount: number;
}

export type RolesActionResult =
  | { ok: true; roles: RoleAdminView[] }
  | { ok: false; message: string };

/** Fila del listado de gestión de usuarios (M9.2). "Histórico" se excluye. */
export interface ManagedUserView {
  membershipId: UUID;
  userId: UUID;
  fullName: string;
  /** Key del rol (sistema o custom) — 0039. */
  role: string;
  /** Nombre visible del rol (roles.label). */
  roleLabel: string;
  isActive: boolean;
  color: string;
  /** null si la fila de auth no es recuperable todavía (placeholder). */
  email: string | null;
  loginStatus: UserLoginStatus;
  /** true si es el propio admin que mira la pantalla (no se auto-edita rol/estado). */
  isSelf: boolean;
  /** Oportunidades activas (no terminales, no canceladas) asignadas. Para el bloqueo de desactivación (Block 3). */
  activeOpportunities: number;
}

export type UsersActionResult =
  | { ok: true; users: ManagedUserView[] }
  | { ok: false; message: string };

/**
 * Carga inicial de la pantalla Usuarios (0039): además de los usuarios,
 * trae los roles asignables (para los selects de invitar/editar). Las
 * mutaciones devuelven `UsersActionResult` (solo users) — el cliente
 * conserva los roles del load inicial.
 */
export type LoadAdminUsersResult =
  | { ok: true; users: ManagedUserView[]; assignableRoles: RoleOption[] }
  | { ok: false; message: string };

/**
 * Resultado de intentar desactivar un usuario (M9.2, Block 3). El caso
 * `has_pending` lleva el conteo de opps activas para que la UI ofrezca
 * reasignarlas antes de desactivar (opción C).
 */
export type DeactivateUserResult =
  | { ok: true; users: ManagedUserView[] }
  | { ok: false; reason: "has_pending"; activeCount: number; message: string }
  | {
      ok: false;
      reason: "forbidden" | "not_found" | "last_admin" | "internal_error";
      message: string;
    };
