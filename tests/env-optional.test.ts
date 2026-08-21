import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Una línea `VARIABLE=` en `.env.local` llega como `""`, no como ausente.
 * Con `z.string().min(1).optional()` eso reventaba el arranque de CUALQUIER
 * script con un error que no mencionaba el archivo — el operador quedaba
 * bloqueado sin pista. Ver ERRORES.md "Validador de env falla por variables
 * opcionales vacías".
 */

const SNAPSHOT = { ...process.env };

async function freshEnv() {
  // El módulo cachea el resultado en un módulo-level let, así que hay que
  // descartar el registro de módulos antes de re-importarlo.
  vi.resetModules();
  return await import("@/lib/env");
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in SNAPSHOT)) delete process.env[k];
  }
  Object.assign(process.env, SNAPSHOT);
});

describe("variables opcionales vacías", () => {
  it("una línea vacía se trata como ausente, no rompe el arranque", async () => {
    process.env.INNGEST_EVENT_KEY = "";
    process.env.INNGEST_SIGNING_KEY = "";
    process.env.UPSTASH_REDIS_REST_URL = "";
    process.env.UPSTASH_REDIS_REST_TOKEN = "";

    const { getServerEnv } = await freshEnv();
    const env = getServerEnv();

    expect(env.INNGEST_EVENT_KEY).toBeUndefined();
    expect(env.UPSTASH_REDIS_REST_URL).toBeUndefined();
  });

  it("solo espacios cuenta igual que vacía", async () => {
    process.env.UPSTASH_REDIS_REST_TOKEN = "   ";
    const { getServerEnv } = await freshEnv();
    expect(getServerEnv().UPSTASH_REDIS_REST_TOKEN).toBeUndefined();
  });

  it("un valor REAL se sigue validando (una URL inválida no pasa)", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "no-es-una-url";
    const { getServerEnv } = await freshEnv();
    expect(() => getServerEnv()).toThrow(/Variables de entorno server/);
  });

  it("un valor real válido se conserva tal cual", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://real.upstash.io";
    process.env.INNGEST_EVENT_KEY = "clave-real";
    const { getServerEnv } = await freshEnv();
    const env = getServerEnv();
    expect(env.UPSTASH_REDIS_REST_URL).toBe("https://real.upstash.io");
    expect(env.INNGEST_EVENT_KEY).toBe("clave-real");
  });

  it("las requeridas siguen siendo requeridas: vacía NO pasa", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "";
    const { getServerEnv } = await freshEnv();
    expect(() => getServerEnv()).toThrow(/Variables de entorno server/);
  });
});
