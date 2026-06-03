import type { PipelineStageRow } from "@/lib/types/database";

/**
 * Tipos compartidos de las pantallas de administración (M7.2) entre
 * server actions y UI. Vive aquí porque los archivos `"use server"`
 * solo pueden exportar funciones async — los tipos compartidos deben
 * venir de otro módulo.
 */

export type StageActionResult =
  | { ok: true; stages: PipelineStageRow[] }
  | { ok: false; message: string };
