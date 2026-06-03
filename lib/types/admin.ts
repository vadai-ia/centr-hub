import type {
  LossReasonRow,
  PipelineStageRow,
  TagClassification,
  UUID,
} from "@/lib/types/database";

/**
 * Tipos compartidos de las pantallas de administración (M7.2) entre
 * server actions y UI. Vive aquí porque los archivos `"use server"`
 * solo pueden exportar funciones async — los tipos compartidos deben
 * venir de otro módulo.
 */

export type StageActionResult =
  | { ok: true; stages: PipelineStageRow[] }
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
