import type { Json } from "@/lib/types/database";

/**
 * Venta por ETIQUETA de Shopify (módulo PURO, sin acceso a BD).
 *
 * Pedido de la dirección: "un apartado donde pueda saber cuánto se está
 * vendiendo por mes con la etiqueta (Evento) — que sea el total".
 *
 * Es una vista TRANSVERSAL, no un canal: la misma venta ya cuenta en el KPI
 * de venta, en la meta del vendedor y —si viene de la tienda online— en la
 * orgánica. Esto solo responde "de todo eso, cuánto llevó esta etiqueta".
 * Sumar esta tarjeta con las demás sería contar dos veces; por eso la tarjeta
 * lo dice en pantalla.
 *
 * Qué etiquetas se muestran es configuración por organización
 * (`config.dashboard.highlight_tags`), NO una lista en código: la dirección
 * inventa etiquetas nuevas (Evento, Embajador…) sin avisar, y cada una no
 * puede costar un deploy.
 */

/** Porción de venta ya reconocida, con las etiquetas de su pedido. */
export interface TaggedRevenueEntry {
  /** Etiquetas crudas del pedido en Shopify. */
  tags?: string[];
  /** Asesor atribuido, para el desglose por vendedor. null = sin asignar. */
  assigned_advisor_id?: string | null;
  /** Monto RECONOCIDO de la porción (ver revenue-recognition). */
  subtotal: string;
  /** Fecha con la que la porción cae en su mes. */
  paid_at: string | null;
}

export interface TaggedRevenue {
  /** Etiqueta tal como la escribió el admin (para mostrar). */
  tag: string;
  /** Total del periodo. */
  total: number;
  /** Cuántas porciones de venta la llevan — útil para "1 pedido, $4,165". */
  count: number;
  byMonth: Array<{ monthKey: string; value: number }>;
  /**
   * Quién vendió con esa etiqueta, de mayor a menor. Solo quienes vendieron
   * algo: una lista con todos los vendedores en cero no dice nada y alarga la
   * tarjeta. `membershipId` null = pedido sin asesor atribuido.
   */
  byAdvisor: Array<{ membershipId: string | null; amount: number }>;
}

/** Mismo criterio que el parser de tags: sin espacios y sin mayúsculas. */
export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/**
 * Etiquetas que la organización quiere ver desglosadas en el Dashboard.
 * Vacío = la tarjeta no se muestra (es lo correcto por defecto: una tarjeta
 * en ceros para una etiqueta que nadie usa es ruido).
 *
 * Tolerante a propósito: una lista mal escrita en el config no debe tumbar el
 * Dashboard entero — se ignora lo que no sea texto y se recorta a 6 para que
 * nadie convierta la pantalla en un listado de 40 etiquetas.
 */
export function readHighlightTags(config: Json | null | undefined): string[] {
  if (!config || typeof config !== "object" || Array.isArray(config)) return [];
  const dashboard = (config as Record<string, unknown>).dashboard;
  if (!dashboard || typeof dashboard !== "object" || Array.isArray(dashboard)) return [];
  const raw = (dashboard as Record<string, unknown>).highlight_tags;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const tag = item.trim();
    if (tag.length === 0) continue;
    const key = normalizeTag(tag);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length === 6) break;
  }
  return out;
}

/**
 * Suma, por etiqueta, la venta reconocida del periodo y su serie por mes.
 *
 * Devuelve una fila por etiqueta CONFIGURADA aunque no haya vendido nada: un
 * cero es información ("este mes no se vendió nada de Evento"), mientras que
 * una fila que desaparece se lee como que la tarjeta está rota.
 *
 * `monthKeyOf` y `monthKeys` llegan de fuera porque el mes se corta en la zona
 * de la ORGANIZACIÓN, y esa decisión no vive aquí.
 */
export function computeTaggedRevenue(input: {
  entries: readonly TaggedRevenueEntry[];
  tags: readonly string[];
  monthKeys: readonly string[];
  monthKeyOf: (iso: string) => string;
}): TaggedRevenue[] {
  const { entries, tags, monthKeys, monthKeyOf } = input;
  if (tags.length === 0) return [];

  return tags.map((tag) => {
    const needle = normalizeTag(tag);
    const months = new Map<string, number>(monthKeys.map((k) => [k, 0]));
    const advisors = new Map<string | null, number>();
    let total = 0;
    let count = 0;

    for (const entry of entries) {
      if (!(entry.tags ?? []).some((t) => normalizeTag(t) === needle)) continue;
      const amount = Number(entry.subtotal);
      if (!Number.isFinite(amount)) continue;
      total += amount;
      count += 1;
      const advisor = entry.assigned_advisor_id ?? null;
      advisors.set(advisor, (advisors.get(advisor) ?? 0) + amount);
      if (!entry.paid_at) continue;
      const key = monthKeyOf(entry.paid_at);
      if (months.has(key)) months.set(key, months.get(key)! + amount);
    }

    return {
      tag,
      total,
      count,
      byMonth: Array.from(months.entries()).map(([monthKey, value]) => ({ monthKey, value })),
      byAdvisor: Array.from(advisors.entries())
        .filter(([, amount]) => amount > 0)
        .map(([membershipId, amount]) => ({ membershipId, amount }))
        .sort((a, b) => b.amount - a.amount),
    };
  });
}
