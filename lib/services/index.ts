/**
 * Capa de servicios — lógica de negocio. Construida ENCIMA del
 * data layer (`lib/db/`). La UI nunca consume esto directo desde
 * Client Components — pasa por server actions o route handlers.
 *
 * Cada módulo aquí expone su API tipada como stub en M1 y se va
 * implementando en su milestone correspondiente:
 *   - tag-parser            → M3
 *   - identity-matching     → M3 / M4
 *   - last-write-wins       → M3 / M4 / M6
 *   - rules-engine          → M8
 *   - f1-to-f2-trigger      → M7
 */

export * as tagParser from "./tag-parser";
export * as identityMatching from "./identity-matching";
export * as lastWriteWins from "./last-write-wins";
export * as rulesEngine from "./rules-engine";
export * as f1ToF2Trigger from "./f1-to-f2-trigger";
