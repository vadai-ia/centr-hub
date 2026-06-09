import { z } from "zod";
import type { Json } from "@/lib/types/database";

/**
 * Dirección estructurada del contacto (Fix de pipeline, Parte 2).
 *
 * Reemplaza al campo plano (`{ line1: <texto> }`) por los 10 campos que
 * replican el formulario de dirección de Shopify, para que la dirección
 * llegue completa a Shopify (campos separados, no un texto plano).
 *
 * Convivencia con direcciones viejas: `parseStoredAddress` lee tanto la
 * forma estructurada nueva como la plana legacy (`line1`/`line2`/`state`/
 * `postal_code`) y las mapea a las claves canónicas. Al guardar
 * (`structuredAddressToJson`) se persiste SOLO la forma canónica, así una
 * dirección vieja se "promueve" a estructurada en cuanto se edita. El
 * backfill de M10.2 podrá completar las viejas (Shopify ya tiene la
 * dirección estructurada). NINGÚN campo es obligatorio.
 *
 * Las claves canónicas coinciden 1:1 con las del Shopify Address
 * (`address1`, `address2`, `city`, `province`, `country`, `zip`, `phone`,
 * `company`, `first_name`, `last_name`), de modo que el mapeo a Shopify
 * es directo.
 */

export interface StructuredAddress {
  /** País o región. */
  country: string;
  /** Nombre (del destinatario de la dirección, no del contacto). */
  first_name: string;
  /** Apellido. */
  last_name: string;
  /** Empresa. */
  company: string;
  /** Calle y número de casa. */
  address1: string;
  /** Apartamento, interior, etc. */
  address2: string;
  /** Código postal. */
  zip: string;
  /** Ciudad. */
  city: string;
  /** Estado. */
  province: string;
  /** Teléfono con código de país (ej. +52). */
  phone: string;
}

export const STRUCTURED_ADDRESS_KEYS: (keyof StructuredAddress)[] = [
  "country",
  "first_name",
  "last_name",
  "company",
  "address1",
  "address2",
  "zip",
  "city",
  "province",
  "phone",
];

const FIELD_MAX = 200;

/** Schema Zod de la dirección estructurada — todos los campos opcionales. */
export const zStructuredAddress = z
  .object({
    country: z.string().max(FIELD_MAX).optional(),
    first_name: z.string().max(FIELD_MAX).optional(),
    last_name: z.string().max(FIELD_MAX).optional(),
    company: z.string().max(FIELD_MAX).optional(),
    address1: z.string().max(FIELD_MAX).optional(),
    address2: z.string().max(FIELD_MAX).optional(),
    zip: z.string().max(FIELD_MAX).optional(),
    city: z.string().max(FIELD_MAX).optional(),
    province: z.string().max(FIELD_MAX).optional(),
    phone: z.string().max(FIELD_MAX).optional(),
  })
  .strip();

export type StructuredAddressInput = z.infer<typeof zStructuredAddress>;

/** Dirección vacía (todos los campos en string vacío) — base del form. */
export function emptyStructuredAddress(): StructuredAddress {
  return {
    country: "",
    first_name: "",
    last_name: "",
    company: "",
    address1: "",
    address2: "",
    zip: "",
    city: "",
    province: "",
    phone: "",
  };
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Lee el `address` jsonb almacenado (estructurado nuevo o plano legacy)
 * y lo normaliza a `StructuredAddress`. Mapea los alias legacy:
 *   line1 → address1, line2 → address2, state → province,
 *   postal_code → zip. La forma nueva tiene prioridad si ambas existen.
 */
export function parseStoredAddress(stored: Json | null | undefined): StructuredAddress {
  const out = emptyStructuredAddress();
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return out;
  const o = stored as Record<string, unknown>;
  out.country = asString(o.country);
  out.first_name = asString(o.first_name);
  out.last_name = asString(o.last_name);
  out.company = asString(o.company);
  out.address1 = asString(o.address1) || asString(o.line1);
  out.address2 = asString(o.address2) || asString(o.line2);
  out.zip = asString(o.zip) || asString(o.postal_code);
  out.city = asString(o.city);
  out.province = asString(o.province) || asString(o.state);
  out.phone = asString(o.phone);
  return out;
}

/** True si la dirección no tiene ningún campo con contenido. */
export function isEmptyStructuredAddress(addr: StructuredAddressInput): boolean {
  return STRUCTURED_ADDRESS_KEYS.every((k) => asString(addr[k]).length === 0);
}

/**
 * Convierte la dirección del form al jsonb del maestro: solo claves
 * canónicas con contenido (trim). Si todas están vacías → null (borrado
 * intencional propagado — R3). Las claves legacy se descartan (la
 * dirección queda "promovida" a estructurada).
 */
export function structuredAddressToJson(addr: StructuredAddressInput): Json | null {
  const obj: Record<string, string> = {};
  for (const key of STRUCTURED_ADDRESS_KEYS) {
    const v = asString(addr[key]);
    if (v.length > 0) obj[key] = v;
  }
  return Object.keys(obj).length > 0 ? (obj as Json) : null;
}

/**
 * Normaliza un string para usarlo como clave de lookup contra catálogo:
 * quita acentos/diacríticos, colapsa espacios y baja a minúsculas. NO se
 * persiste — solo se usa para resolver país/estado a códigos Shopify.
 */
function lookupKey(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * País (nombre libre) → ISO 3166-1 alpha-2. Shopify valida `country`
 * contra su catálogo (rechaza "México" con acento), pero acepta
 * `country_code` de forma determinística. Mapeamos las variantes
 * razonables (con/sin acento, ES/EN, código de 2 letras) a su código.
 * Lo que no reconocemos se manda tal cual y, si Shopify lo rechaza, el
 * mensaje real se le muestra al usuario.
 */
const COUNTRY_TO_ISO2: Record<string, string> = {
  mexico: "MX",
  "estados unidos mexicanos": "MX",
  mx: "MX",
  "estados unidos": "US",
  "estados unidos de america": "US",
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  eua: "US",
  us: "US",
  canada: "CA",
  ca: "CA",
  espana: "ES",
  spain: "ES",
  es: "ES",
  guatemala: "GT",
  colombia: "CO",
  argentina: "AR",
  chile: "CL",
  peru: "PE",
  brasil: "BR",
  brazil: "BR",
};

/**
 * Estado de México (nombre libre) → ISO 3166-2:MX (código que Shopify usa
 * como `province_code`). Cubre los 32 estados + alias comunes (CDMX, DF,
 * EdoMex). Resolver a `province_code` evita que un acento en el nombre del
 * estado haga fallar la validación de Shopify.
 */
const MX_PROVINCE_TO_CODE: Record<string, string> = {
  aguascalientes: "AGU",
  "baja california": "BCN",
  "baja california sur": "BCS",
  campeche: "CAM",
  chiapas: "CHP",
  chihuahua: "CHH",
  "ciudad de mexico": "CMX",
  cdmx: "CMX",
  "distrito federal": "CMX",
  df: "CMX",
  coahuila: "COA",
  "coahuila de zaragoza": "COA",
  colima: "COL",
  durango: "DUR",
  guanajuato: "GUA",
  guerrero: "GRO",
  hidalgo: "HID",
  jalisco: "JAL",
  mexico: "MEX",
  "estado de mexico": "MEX",
  edomex: "MEX",
  michoacan: "MIC",
  "michoacan de ocampo": "MIC",
  morelos: "MOR",
  nayarit: "NAY",
  "nuevo leon": "NLE",
  oaxaca: "OAX",
  puebla: "PUE",
  queretaro: "QUE",
  "quintana roo": "ROO",
  "san luis potosi": "SLP",
  sinaloa: "SIN",
  sonora: "SON",
  tabasco: "TAB",
  tamaulipas: "TAM",
  tlaxcala: "TLA",
  veracruz: "VER",
  "veracruz de ignacio de la llave": "VER",
  yucatan: "YUC",
  zacatecas: "ZAC",
};

/**
 * Mapea la dirección estructurada a UN objeto Shopify Address. Las claves
 * canónicas coinciden 1:1, salvo país/estado que se normalizan a códigos
 * Shopify (`country_code` / `province_code`) cuando se reconocen — así un
 * valor escribible-por-humano ("México", "Nuevo León") no rompe la
 * validación de Shopify. El maestro conserva el valor legible; solo el
 * payload saliente lleva el código. Devuelve null si está vacía.
 * `fallbackPhone` se usa cuando la dirección no trae teléfono propio.
 */
export function structuredAddressToShopify(
  addr: StructuredAddressInput,
  fallbackPhone?: string | null,
): Record<string, string> | null {
  const obj: Record<string, string> = {};
  for (const key of STRUCTURED_ADDRESS_KEYS) {
    const v = asString(addr[key]);
    if (v.length > 0) obj[key] = v;
  }
  if (Object.keys(obj).length === 0) return null;
  if (!obj.phone && fallbackPhone) obj.phone = fallbackPhone;

  // País → country_code cuando se reconoce. Si no, se deja el nombre tal
  // cual y Shopify decide (su error real se le muestra al usuario).
  let countryIso: string | null = null;
  if (obj.country) {
    const iso = COUNTRY_TO_ISO2[lookupKey(obj.country)];
    if (iso) {
      countryIso = iso;
      obj.country_code = iso;
      delete obj.country;
    }
  }

  // Estado → province_code solo cuando el país es México (única matriz de
  // subdivisiones que mapeamos). Para otros países se deja el nombre tal
  // cual. Requiere country_code MX explícito para no adivinar.
  if (obj.province && countryIso === "MX") {
    const code = MX_PROVINCE_TO_CODE[lookupKey(obj.province)];
    if (code) {
      obj.province_code = code;
      delete obj.province;
    }
  }

  return obj;
}

/** Resumen en una línea para listados/lectura (no incluye nombre/teléfono). */
export function formatStructuredAddress(addr: StructuredAddressInput): string | null {
  const parts = [
    asString(addr.address1),
    asString(addr.address2),
    asString(addr.city),
    asString(addr.province),
    asString(addr.zip),
    asString(addr.country),
  ].filter((s) => s.length > 0);
  return parts.length > 0 ? parts.join(", ") : null;
}
