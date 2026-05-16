/**
 * Setup global de Vitest.
 *
 * Establecemos valores placeholder para las variables de entorno
 * requeridas. Los tests de M1 son code-level (no tocan Supabase
 * real); la validación contra BD real la cubre el operador
 * aplicando las migraciones + creando dos orgs sintéticas tal
 * como dice el checklist del prompt de M1.
 *
 * `server-only` se neutraliza vía alias en vitest.config no
 * porque tenemos un mock de módulo aquí — la lib es un re-export
 * vacío en server contexts y un throw en client; en Node de
 * tests ambos paths funcionan.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://test.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";

// `server-only` no se debe importar en client. En tests Node es
// transparente — el módulo existe pero no rompe nada. Si Vitest
// emite warning, redirigirlo a un stub vacío:
import { vi } from "vitest";
vi.mock("server-only", () => ({}));
