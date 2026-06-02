import "server-only";
import { z } from "zod";

/**
 * Mappers Shopify (Sección 3.6).
 *
 * Dos formas de entrada normalizadas a la misma shape interna:
 *   - Webhook REST (snake_case, sin __typename, ids como números → string)
 *   - GraphQL Admin (camelCase, gids `gid://shopify/Customer/123`, line_items
 *     bajo `lineItems.nodes`, etc.)
 *
 * Mantenemos schemas Zod laxos (no `.strict()`) — Shopify agrega
 * campos con frecuencia y el upstream no debe romper en upgrades.
 * Sólo validamos los campos que consumimos.
 *
 * Helpers de normalización:
 *   - shopifyIdToString: tanto webhooks (number) como GraphQL (gid)
 *     se aplanan a `"<id>"` para almacenar como text en BD.
 */

// ============================================================
// Helpers de normalización
// ============================================================

export function shopifyIdToString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    // Acepta numbers como strings y gids
    const gidMatch = value.match(/^gid:\/\/shopify\/[^/]+\/(\d+)$/);
    if (gidMatch) return gidMatch[1];
    return value;
  }
  return null;
}

export function shopifyTagsCsvToArray(csv: string | string[] | null | undefined): string[] {
  if (!csv) return [];
  if (Array.isArray(csv)) return csv.map((t) => t.trim()).filter((t) => t.length > 0);
  return csv.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
}

// ============================================================
// Customer
// ============================================================

const customerAddressSchema = z
  .object({
    address1: z.string().nullable().optional(),
    address2: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    province: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    zip: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    company: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * Extrae el teléfono del customer respetando el orden de precedencia
 * observado en Shopify: primero el campo top-level del customer; si
 * está vacío o ausente, cae a `default_address.phone`.
 *
 * Motivo (ver ERRORES.md): muchos customers de Shopify guardan el
 * teléfono SOLO en la dirección — especialmente los creados vía
 * checkout sin que el merchant edite manualmente el perfil. Leer
 * únicamente el campo top-level descartaba esos teléfonos.
 *
 * Mantiene strings tal cual (incluso si no son E.164) — la
 * normalización vía libphonenumber-js corre downstream en el helper
 * de identity-matching (`normalizePhone`), no acá.
 */
function pickCustomerPhone(
  profilePhone: string | null | undefined,
  address: { phone?: string | null } | null | undefined,
): string | null {
  const profileTrimmed = (profilePhone ?? "").trim();
  if (profileTrimmed.length > 0) return profilePhone ?? null;
  const addressPhone = address?.phone;
  const addressTrimmed = (addressPhone ?? "").trim();
  if (addressTrimmed.length > 0) return addressPhone ?? null;
  return null;
}

export const shopifyCustomerWebhookSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    email: z.string().nullable().optional(),
    first_name: z.string().nullable().optional(),
    last_name: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    tags: z.union([z.string(), z.array(z.string())]).nullable().optional(),
    state: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    default_address: customerAddressSchema.nullable().optional(),
    updated_at: z.string().nullable().optional(),
    created_at: z.string().nullable().optional(),
  })
  .passthrough();

export type ShopifyCustomerWebhook = z.infer<typeof shopifyCustomerWebhookSchema>;

export interface NormalizedCustomer {
  shopifyCustomerId: string;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  tags: string[];
  state: string | null;
  note: string | null;
  address: Record<string, unknown> | null;
  updatedAt: string | null;
  createdAt: string | null;
}

export function mapCustomerWebhookToNormalized(
  raw: unknown,
): NormalizedCustomer {
  const data = shopifyCustomerWebhookSchema.parse(raw);
  const id = shopifyIdToString(data.id);
  if (!id) throw new Error("mapCustomerWebhook: id ausente");
  const fullName = [data.first_name, data.last_name]
    .filter((s) => s && s.trim().length > 0)
    .join(" ")
    .trim();
  return {
    shopifyCustomerId: id,
    fullName: fullName.length > 0 ? fullName : null,
    email: data.email ?? null,
    phone: pickCustomerPhone(data.phone ?? null, data.default_address ?? null),
    tags: shopifyTagsCsvToArray(data.tags ?? null),
    state: data.state ?? null,
    note: data.note ?? null,
    address: data.default_address ?? null,
    updatedAt: data.updated_at ?? null,
    createdAt: data.created_at ?? null,
  };
}

// ============================================================
// Customer embebido en payloads de Order / Draft Order
// ============================================================
//
// Shopify incluye el OBJETO completo del customer (no solo el id)
// dentro de los webhooks de orders/* y draft_orders/*. Antes del fix
// (M3 post-entrega) los schemas tipaban únicamente `customer.id`,
// descartando `first_name`, `last_name`, `email`, `phone`,
// `default_address`, etc. Resultado: cuando un order/draft_order
// llegaba antes que un customers/create, el contacto local nacía
// como stub vacío y nunca se rellenaba (Shopify no reenvía
// customers/create retroactivo). Ver ERRORES.md.

const embeddedCustomerSchema = z
  .object({
    id: z.union([z.number(), z.string()]).nullable().optional(),
    first_name: z.string().nullable().optional(),
    last_name: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    tags: z.union([z.string(), z.array(z.string())]).nullable().optional(),
    state: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    default_address: customerAddressSchema.nullable().optional(),
    updated_at: z.string().nullable().optional(),
    created_at: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * Convierte el customer embebido (puede venir null, undefined, o sin
 * `id`) a `NormalizedCustomer | null`. Devuelve null si no hay id
 * extraíble — sin id no podemos enlazar a la entidad Shopify, así
 * que se descarta cualquier hidratación.
 */
function mapEmbeddedCustomer(raw: unknown): NormalizedCustomer | null {
  if (raw === null || raw === undefined) return null;
  const parsed = embeddedCustomerSchema.safeParse(raw);
  if (!parsed.success) return null;
  const data = parsed.data;
  const id = shopifyIdToString(data.id ?? null);
  if (!id) return null;
  const fullName = [data.first_name, data.last_name]
    .filter((s) => s && s.trim().length > 0)
    .join(" ")
    .trim();
  return {
    shopifyCustomerId: id,
    fullName: fullName.length > 0 ? fullName : null,
    email: data.email ?? null,
    phone: pickCustomerPhone(data.phone ?? null, data.default_address ?? null),
    tags: shopifyTagsCsvToArray(data.tags ?? null),
    state: data.state ?? null,
    note: data.note ?? null,
    address: data.default_address ?? null,
    updatedAt: data.updated_at ?? null,
    createdAt: data.created_at ?? null,
  };
}

// ============================================================
// Line items (compartido entre Draft Order y Order)
// ============================================================

const moneyLikeSchema = z.union([z.string(), z.number()]).nullable().optional();

const draftLineItemSchema = z
  .object({
    title: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    sku: z.string().nullable().optional(),
    quantity: z.number().nullable().optional(),
    variant_title: z.string().nullable().optional(),
    product_id: z.union([z.number(), z.string()]).nullable().optional(),
    variant_id: z.union([z.number(), z.string()]).nullable().optional(),
    price: moneyLikeSchema,
    original_price: moneyLikeSchema,
    discounted_price: moneyLikeSchema,
    applied_discount: z
      .object({
        amount: moneyLikeSchema,
        value: moneyLikeSchema,
        value_type: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    grams: z.number().nullable().optional(),
    taxable: z.boolean().nullable().optional(),
    custom: z.boolean().nullable().optional(),
  })
  .passthrough();

const orderLineItemSchema = z
  .object({
    title: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    sku: z.string().nullable().optional(),
    quantity: z.number().nullable().optional(),
    variant_title: z.string().nullable().optional(),
    product_id: z.union([z.number(), z.string()]).nullable().optional(),
    variant_id: z.union([z.number(), z.string()]).nullable().optional(),
    price: moneyLikeSchema,
    total_discount: moneyLikeSchema,
    grams: z.number().nullable().optional(),
    taxable: z.boolean().nullable().optional(),
  })
  .passthrough();

export interface NormalizedLineItem {
  shopifyProductId: string | null;
  shopifyVariantId: string | null;
  title: string;
  sku: string | null;
  quantity: number;
  variantTitle: string | null;
  originalUnitPrice: string;
  discountAmount: string;
  finalPrice: string;
  weightGrams: string | null;
  taxable: boolean;
}

function moneyToString(v: unknown): string {
  if (v === null || v === undefined) return "0";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "0";
}

export function mapDraftLineItem(raw: unknown): NormalizedLineItem {
  const li = draftLineItemSchema.parse(raw);
  const quantity = Math.max(0, li.quantity ?? 0);
  const unit = moneyToString(li.original_price ?? li.price);
  // Si el Draft Order trae `applied_discount.amount` (descuento total
  // de la línea), úsalo; si no, derivar de (price - discounted_price).
  let discount = "0";
  if (li.applied_discount?.amount !== undefined && li.applied_discount.amount !== null) {
    discount = moneyToString(li.applied_discount.amount);
  } else if (li.price !== null && li.discounted_price !== null) {
    const total = Number(moneyToString(li.price)) * quantity;
    const discTotal = Number(moneyToString(li.discounted_price)) * quantity;
    const diff = total - discTotal;
    discount = diff > 0 ? diff.toFixed(2) : "0";
  }
  const finalPrice = moneyToString(li.discounted_price ?? li.price);
  return {
    shopifyProductId: shopifyIdToString(li.product_id ?? null),
    shopifyVariantId: shopifyIdToString(li.variant_id ?? null),
    title: li.title ?? li.name ?? "(sin título)",
    sku: li.sku ?? null,
    quantity,
    variantTitle: li.variant_title ?? null,
    originalUnitPrice: unit,
    discountAmount: discount,
    finalPrice,
    weightGrams: li.grams !== null && li.grams !== undefined ? String(li.grams) : null,
    taxable: li.taxable ?? true,
  };
}

export function mapOrderLineItem(raw: unknown): NormalizedLineItem {
  const li = orderLineItemSchema.parse(raw);
  const quantity = Math.max(0, li.quantity ?? 0);
  return {
    shopifyProductId: shopifyIdToString(li.product_id ?? null),
    shopifyVariantId: shopifyIdToString(li.variant_id ?? null),
    title: li.title ?? li.name ?? "(sin título)",
    sku: li.sku ?? null,
    quantity,
    variantTitle: li.variant_title ?? null,
    originalUnitPrice: moneyToString(li.price),
    discountAmount: moneyToString(li.total_discount),
    finalPrice: moneyToString(li.price),
    weightGrams: li.grams !== null && li.grams !== undefined ? String(li.grams) : null,
    taxable: li.taxable ?? true,
  };
}

// ============================================================
// Draft Order
// ============================================================

export const shopifyDraftOrderWebhookSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    name: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    tags: z.union([z.string(), z.array(z.string())]).nullable().optional(),
    customer: embeddedCustomerSchema.nullable().optional(),
    line_items: z.array(z.unknown()).default([]),
    total_price: moneyLikeSchema,
    subtotal_price: moneyLikeSchema,
    total_tax: moneyLikeSchema,
    currency: z.string().nullable().optional(),
    invoice_url: z.string().nullable().optional(),
    shipping_address: z.record(z.string(), z.unknown()).nullable().optional(),
    updated_at: z.string().nullable().optional(),
    created_at: z.string().nullable().optional(),
    completed_at: z.string().nullable().optional(),
  })
  .passthrough();

export type ShopifyDraftOrderWebhook = z.infer<typeof shopifyDraftOrderWebhookSchema>;

export interface NormalizedDraftOrder {
  shopifyDraftOrderId: string;
  displayReference: string | null;
  note: string | null;
  tags: string[];
  shopifyCustomerId: string | null;
  /**
   * Datos del customer extraídos del payload de la Draft Order
   * (Shopify incluye el objeto completo, no solo el id). Permite
   * que el worker hidrate el contacto local sin esperar a un
   * customers/* webhook. `null` si el payload no trae customer o
   * trae uno sin `id`.
   */
  embeddedCustomer: NormalizedCustomer | null;
  lineItems: NormalizedLineItem[];
  totalAmount: string;
  subtotalAmount: string;
  taxesAmount: string;
  currency: string;
  invoiceUrl: string | null;
  shippingAddress: Record<string, unknown> | null;
  updatedAt: string | null;
  createdAt: string | null;
  completedAt: string | null;
}

export function mapDraftOrderWebhookToNormalized(raw: unknown): NormalizedDraftOrder {
  const data = shopifyDraftOrderWebhookSchema.parse(raw);
  const id = shopifyIdToString(data.id);
  if (!id) throw new Error("mapDraftOrderWebhook: id ausente");
  const embeddedCustomer = mapEmbeddedCustomer(data.customer ?? null);
  return {
    shopifyDraftOrderId: id,
    displayReference: data.name ?? null,
    note: data.note ?? null,
    tags: shopifyTagsCsvToArray(data.tags ?? null),
    shopifyCustomerId: embeddedCustomer?.shopifyCustomerId ?? null,
    embeddedCustomer,
    lineItems: data.line_items.map(mapDraftLineItem),
    totalAmount: moneyToString(data.total_price),
    subtotalAmount: moneyToString(data.subtotal_price),
    taxesAmount: moneyToString(data.total_tax),
    currency: data.currency ?? "MXN",
    invoiceUrl: data.invoice_url ?? null,
    shippingAddress: data.shipping_address ?? null,
    updatedAt: data.updated_at ?? null,
    createdAt: data.created_at ?? null,
    completedAt: data.completed_at ?? null,
  };
}

// ============================================================
// Order
// ============================================================

export const shopifyOrderWebhookSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    name: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    tags: z.union([z.string(), z.array(z.string())]).nullable().optional(),
    customer: embeddedCustomerSchema.nullable().optional(),
    line_items: z.array(z.unknown()).default([]),
    total_price: moneyLikeSchema,
    subtotal_price: moneyLikeSchema,
    total_tax: moneyLikeSchema,
    total_shipping_price_set: z
      .object({ shop_money: z.object({ amount: moneyLikeSchema }).passthrough().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    total_discounts: moneyLikeSchema,
    currency: z.string().nullable().optional(),
    financial_status: z.string().nullable().optional(),
    fulfillment_status: z.string().nullable().optional(),
    cancel_reason: z.string().nullable().optional(),
    cancelled_at: z.string().nullable().optional(),
    processed_at: z.string().nullable().optional(),
    source_name: z.string().nullable().optional(),
    updated_at: z.string().nullable().optional(),
    created_at: z.string().nullable().optional(),
    closed_at: z.string().nullable().optional(),
    draft_order_id: z.union([z.number(), z.string()]).nullable().optional(),
    note_attributes: z.array(z.record(z.string(), z.unknown())).default([]).optional(),
  })
  .passthrough();

export type ShopifyOrderWebhook = z.infer<typeof shopifyOrderWebhookSchema>;

export interface NormalizedOrder {
  shopifyOrderId: string;
  shopifyName: string | null;
  tags: string[];
  shopifyCustomerId: string | null;
  /**
   * Datos del customer extraídos del payload del Order (Shopify
   * incluye el objeto completo, no solo el id). Permite que el
   * worker hidrate el contacto local sin esperar a un customers/*
   * webhook. `null` si el payload no trae customer o trae uno sin
   * `id`.
   */
  embeddedCustomer: NormalizedCustomer | null;
  shopifyDraftOrderId: string | null;
  lineItems: NormalizedLineItem[];
  totalAmount: string;
  subtotalAmount: string;
  taxesAmount: string;
  shippingAmount: string;
  discountAmount: string;
  currency: string;
  financialStatus: string;
  fulfillmentStatus: string | null;
  cancellationReason: string | null;
  source: string | null;
  paidAt: string | null;
  cancelledAt: string | null;
  updatedAt: string | null;
  createdAt: string | null;
}

export function mapOrderWebhookToNormalized(raw: unknown): NormalizedOrder {
  const data = shopifyOrderWebhookSchema.parse(raw);
  const id = shopifyIdToString(data.id);
  if (!id) throw new Error("mapOrderWebhook: id ausente");
  const shipping =
    data.total_shipping_price_set?.shop_money?.amount ?? null;
  const embeddedCustomer = mapEmbeddedCustomer(data.customer ?? null);
  return {
    shopifyOrderId: id,
    shopifyName: data.name ?? null,
    tags: shopifyTagsCsvToArray(data.tags ?? null),
    shopifyCustomerId: embeddedCustomer?.shopifyCustomerId ?? null,
    embeddedCustomer,
    shopifyDraftOrderId: shopifyIdToString(data.draft_order_id ?? null),
    lineItems: data.line_items.map(mapOrderLineItem),
    totalAmount: moneyToString(data.total_price),
    subtotalAmount: moneyToString(data.subtotal_price),
    taxesAmount: moneyToString(data.total_tax),
    shippingAmount: moneyToString(shipping),
    discountAmount: moneyToString(data.total_discounts),
    currency: data.currency ?? "MXN",
    financialStatus: data.financial_status ?? "pending",
    fulfillmentStatus: data.fulfillment_status ?? null,
    cancellationReason: data.cancel_reason ?? null,
    source: data.source_name ?? null,
    paidAt: data.processed_at ?? null,
    cancelledAt: data.cancelled_at ?? null,
    updatedAt: data.updated_at ?? null,
    createdAt: data.created_at ?? null,
  };
}

// ============================================================
// GraphQL helpers (queries directas — usados por backfill / refresh)
// ============================================================

/**
 * Convierte un nodo GraphQL Customer a la misma shape normalizada
 * que el webhook. La query GraphQL debe traer los campos:
 *   id, firstName, lastName, email, phone, tags, state, note,
 *   defaultAddress { address1 address2 city province country zip phone },
 *   updatedAt, createdAt.
 */
export function mapCustomerGraphqlToNormalized(node: unknown): NormalizedCustomer {
  if (!node || typeof node !== "object") {
    throw new Error("mapCustomerGraphql: nodo inválido");
  }
  const n = node as Record<string, unknown>;
  const id = shopifyIdToString(n.id);
  if (!id) throw new Error("mapCustomerGraphql: id ausente");
  const firstName = (n.firstName as string | null) ?? null;
  const lastName = (n.lastName as string | null) ?? null;
  const fullName = [firstName, lastName].filter((s) => s && s.trim()).join(" ").trim();
  const defaultAddress =
    (n.defaultAddress as { phone?: string | null } | null | undefined) ?? null;
  return {
    shopifyCustomerId: id,
    fullName: fullName.length > 0 ? fullName : null,
    email: (n.email as string | null) ?? null,
    phone: pickCustomerPhone((n.phone as string | null) ?? null, defaultAddress),
    tags: Array.isArray(n.tags)
      ? (n.tags as string[]).map((t) => t.trim()).filter((t) => t.length > 0)
      : shopifyTagsCsvToArray((n.tags as string | null) ?? null),
    state: (n.state as string | null) ?? null,
    note: (n.note as string | null) ?? null,
    address: (n.defaultAddress as Record<string, unknown> | null) ?? null,
    updatedAt: (n.updatedAt as string | null) ?? null,
    createdAt: (n.createdAt as string | null) ?? null,
  };
}

/**
 * Convierte un nodo GraphQL Order a la shape normalizada (subset
 * usado por backfill). El backfill incremental de M3 hace REST,
 * pero esta función queda lista para M11.
 */
export function mapOrderGraphqlToNormalized(node: unknown): NormalizedOrder {
  if (!node || typeof node !== "object") {
    throw new Error("mapOrderGraphql: nodo inválido");
  }
  const n = node as Record<string, unknown>;
  const id = shopifyIdToString(n.id);
  if (!id) throw new Error("mapOrderGraphql: id ausente");
  const lineItemsNodes =
    (n.lineItems as { nodes?: unknown[] } | null)?.nodes ?? [];
  const customer = n.customer as Record<string, unknown> | null;
  return {
    shopifyOrderId: id,
    shopifyName: (n.name as string | null) ?? null,
    tags: Array.isArray(n.tags)
      ? (n.tags as string[]).map((t) => t.trim()).filter((t) => t.length > 0)
      : shopifyTagsCsvToArray((n.tags as string | null) ?? null),
    shopifyCustomerId: customer ? shopifyIdToString(customer.id) : null,
    // GraphQL backfill (M11) hidrata el customer via GET /customers/{id}.json
    // por separado, así que aquí dejamos null para no asumir shape camelCase.
    embeddedCustomer: null,
    shopifyDraftOrderId: null,
    lineItems: lineItemsNodes.map((raw) => {
      const li = raw as Record<string, unknown>;
      const quantity = Math.max(0, (li.quantity as number) ?? 0);
      const variant = li.variant as Record<string, unknown> | null;
      const variantId = variant ? shopifyIdToString(variant.id) : null;
      const productId =
        variant && variant.product
          ? shopifyIdToString((variant.product as Record<string, unknown>).id)
          : null;
      const originalSet = (li.originalUnitPriceSet as Record<string, unknown> | null)
        ?.shopMoney as Record<string, unknown> | undefined;
      const discountedSet = (li.discountedUnitPriceSet as Record<string, unknown> | null)
        ?.shopMoney as Record<string, unknown> | undefined;
      return {
        shopifyProductId: productId,
        shopifyVariantId: variantId,
        title: ((li.title as string) ?? (li.name as string) ?? "(sin título)") as string,
        sku: (li.sku as string | null) ?? null,
        quantity,
        variantTitle: (li.variantTitle as string | null) ?? null,
        originalUnitPrice: moneyToString(originalSet?.amount),
        discountAmount: moneyToString(
          originalSet && discountedSet
            ? Math.max(
                0,
                Number(originalSet.amount ?? 0) - Number(discountedSet.amount ?? 0),
              ) * quantity
            : 0,
        ),
        finalPrice: moneyToString(discountedSet?.amount ?? originalSet?.amount),
        weightGrams: null,
        taxable: (li.taxable as boolean) ?? true,
      };
    }),
    totalAmount: moneyToString(
      (n.totalPriceSet as Record<string, unknown> | null)?.shopMoney
        ? ((n.totalPriceSet as Record<string, unknown>).shopMoney as Record<string, unknown>).amount
        : null,
    ),
    subtotalAmount: moneyToString(
      (n.subtotalPriceSet as Record<string, unknown> | null)?.shopMoney
        ? ((n.subtotalPriceSet as Record<string, unknown>).shopMoney as Record<string, unknown>).amount
        : null,
    ),
    taxesAmount: moneyToString(
      (n.totalTaxSet as Record<string, unknown> | null)?.shopMoney
        ? ((n.totalTaxSet as Record<string, unknown>).shopMoney as Record<string, unknown>).amount
        : null,
    ),
    shippingAmount: moneyToString(
      (n.totalShippingPriceSet as Record<string, unknown> | null)?.shopMoney
        ? ((n.totalShippingPriceSet as Record<string, unknown>).shopMoney as Record<string, unknown>).amount
        : null,
    ),
    discountAmount: moneyToString(
      (n.totalDiscountsSet as Record<string, unknown> | null)?.shopMoney
        ? ((n.totalDiscountsSet as Record<string, unknown>).shopMoney as Record<string, unknown>).amount
        : null,
    ),
    currency: ((n.currencyCode as string) ?? "MXN") as string,
    financialStatus: ((n.displayFinancialStatus as string | null) ?? "pending").toLowerCase(),
    fulfillmentStatus: ((n.displayFulfillmentStatus as string | null) ?? null)?.toLowerCase() ?? null,
    cancellationReason: ((n.cancelReason as string | null) ?? null)?.toLowerCase() ?? null,
    source: (n.sourceName as string | null) ?? null,
    paidAt: (n.processedAt as string | null) ?? null,
    cancelledAt: (n.cancelledAt as string | null) ?? null,
    updatedAt: (n.updatedAt as string | null) ?? null,
    createdAt: (n.createdAt as string | null) ?? null,
  };
}
