# ERRORES.md — Bugs conocidos, workarounds y lecciones del proyecto Centr Hub

> Documento vivo. Cada bug descubierto durante un milestone se documenta aquí antes del commit final del milestone. Permite a milestones posteriores no repetir los mismos errores.

## Estructura de cada entrada

Cada entrada documenta UN bug o lección con la siguiente estructura:

- **Título:** descripción corta del problema.
- **Milestone donde se detectó:** M0, M1, M2, ...
- **Síntoma:** qué se observó.
- **Causa raíz:** qué lo provocó.
- **Workaround / fix:** cómo se resolvió o cómo evitarlo.
- **Lección:** principio general que aplica a milestones futuros.

(Formato y ejemplos ilustrativos en Sección 10.4 de la doctrina, `CENTR-DOCTRINE-v5.md`.)

## Entradas

### RETURNING INTO variable escalar con INSERT multi-fila falla en PL/pgSQL

- **Milestone donde se detectó:** M1.
- **Síntoma:** función `bootstrap_organization` fallaba con `ERROR: P0003: query returned more than one row` en la línea del INSERT de 7 etapas Funnel Venta.
- **Causa raíz:** `INSERT ... VALUES (multi-fila) RETURNING id INTO variable_escalar` es inválido en PL/pgSQL — una variable escalar solo puede recibir 1 fila. Para casos multi-fila se requiere `RETURNING ... BULK COLLECT INTO arr` o, como en este caso, eliminar la cláusula RETURNING si no se necesita.
- **Workaround / fix:** se eliminó la cláusula `RETURNING ... INTO` del INSERT multi-fila. Los IDs de las etapas se recuperan inmediatamente después por nombre con `SELECT ... INTO ...`, que era la lógica funcional. La línea problemática era redundante.
- **Lección:** cuando un INSERT inserta múltiples filas y la lógica posterior necesita los IDs, NO usar `RETURNING ... INTO variable_escalar`. Opciones válidas: (a) recuperar por columna única posterior con SELECT, (b) usar `RETURNING ... BULK COLLECT INTO array`, (c) hacer INSERTs uno por uno con su propio RETURNING. La opción (a) es legible y suficiente cuando ya hay un identificador único como `name + organization_id + funnel`.

### Flujo de invitación incompleto — hash fragment vs PKCE en Supabase Auth

- **Milestone donde se detectó:** M2 (fix post-entrega).
- **Síntoma:** click en el email de invitación de Supabase redirigía al usuario a `/login` sin mostrar ninguna pantalla para definir contraseña. La activación de cuenta nunca se completaba.
- **Causa raíz:** `app/auth/callback/route.ts` (Route Handler) sólo manejaba el flujo PKCE — tokens llegando como `?code=`. Supabase envía las invitaciones (y password recovery) en flujo implícito: los tokens llegan como `#access_token=...&refresh_token=...&type=invite` (hash fragment). Los hash fragments son **client-side only** — el servidor nunca los recibe. El Route Handler veía la request sin `?code=`, caía al catch-all, y redirigía a `/login?error=link_expired`.
- **Workaround / fix:**
  1. **Route Handler actualizado:** si no hay `?code=`, devuelve un HTML mínimo con `<script>window.location.replace('/auth/confirm'+window.location.hash)</script>`. El script ejecuta en el navegador y redirige a `/auth/confirm` preservando el hash fragment (que el servidor nunca habría visto). `window.location.replace` evita que `/auth/callback` quede en el historial del navegador.
  2. **Nueva página `/auth/confirm`** (`app/(auth)/auth/confirm/page.tsx`): Client Component que parsea el hash en `useEffect`. Para `type=invite` o `type=recovery` renderiza un formulario para definir contraseña (validación mínima 8 caracteres + confirmación). Llama `supabase.auth.setSession()` con los tokens del hash y luego `supabase.auth.updateUser({ password })`. Para `type=magiclink`/`email` establece sesión y redirige al dashboard. Edge cases: hash vacío, error en hash, tokens expirados — todos muestran mensaje en español con link a `/login`.
  3. **Middleware actualizado:** `/auth/confirm` agregado a `PUBLIC_ROUTES`.
- **Lección (parte 1 — Route Handler):** Supabase Auth tiene **dos flujos distintos en Next.js App Router**: (a) **PKCE** (`?code=` → `exchangeCodeForSession` en Route Handler o Server Component) y (b) **Implícito** (`#access_token=` → sólo accesible client-side). Las invitaciones y password recovery de Supabase usan el flujo implícito con hash fragment. Un Route Handler nunca puede manejarlos directamente. La técnica correcta es servir desde el Route Handler un HTML mínimo que haga el redirect client-side con `window.location.replace`, preservando el hash. La nueva página `/auth/confirm` actúa como landing unificado para todos los flujos de hash.
- **Lección (parte 2 — Site URL como landing):** `/auth/confirm` sólo recibe tokens si Supabase está configurado con una URL específica como redirect (ej. `redirect_to=/auth/callback`). Cuando el Site URL de Supabase es la raíz del dominio (`http://localhost:3000`), las invitaciones aterrizan en `/login#access_token=...` — la página de login ignora el hash y el flujo muere silenciosamente. **Fix:** `LoginForm` (`components/auth/login-form.tsx`) detecta en `useEffect` si `window.location.hash` contiene `access_token`; si es así, hace `window.location.replace('/auth/confirm' + hash)` antes de renderizar el formulario (`ready` state en `false` evita que el form flashee). No basta con tener `/auth/confirm` aislado: cualquier página pública a la que Supabase pueda redirigir debe también interceptar el hash.

### Validador de env falla en startup por variables opcionales definidas vacías en .env.local

- **Milestone donde se detectó:** M2 (fix post-entrega).
- **Síntoma:** la app falla al arrancar con `Variables de entorno server inválidas: ...` señalando `SHOPIFY_WEBHOOK_SECRET` y/o `WHAAPY_API_KEY`. Estas variables están en `.env.local` como `SHOPIFY_WEBHOOK_SECRET=` (vacías a propósito, pendientes de M3).
- **Causa raíz:** `z.string().min(1).optional()` en Zod NO es equivalente a "ausente o no vacío". `.optional()` permite `undefined` (campo ausente), pero cuando la variable SÍ existe en el entorno como cadena vacía `""`, Zod la ve como presente y aplica `.min(1)` — que falla. En `.env.local`, `VARIABLE=` sin valor se expande como `""` en `process.env`, no como `undefined`.
- **Workaround / fix:** cambiar a `z.string().optional()` (sin `.min(1)`) para las dos variables de entrada diferida. El startup validator solo exige que, si están presentes, sean strings — sin restricción de longitud. Para proteger el uso en runtime, se agregan helpers de acceso tardío `getShopifyWebhookSecret()` y `getWhaapyApiKey()` en `lib/env.ts`: lanzan un error descriptivo con contexto de milestone cuando la variable está vacía o ausente. M3+ debe usar estos helpers en lugar de leer `getServerEnv().SHOPIFY_WEBHOOK_SECRET` directamente.
- **Lección:** en proyectos con milestones incrementales, distinguir entre dos categorías de variables en el schema de Zod: (a) **siempre requeridas** — `z.string().min(1)` sin `.optional()`, falla en startup si faltan; (b) **requeridas desde milestone X** — `z.string().optional()` en startup + helper de acceso que valida en runtime. La validación tardía es preferible a eliminar la protección: el error sigue siendo descriptivo, pero no bloquea arranques legítimos en milestones anteriores. Antipatrón a evitar: `z.string().min(1).optional()` — comunica "no vacío si presente" pero la semántica de startup es confusa cuando `.env.local` define la variable como vacía.

### supabase-js 2.105 — Database type hand-written incompatible con shape estricta

- **Milestone donde se detectó:** M1.
- **Síntoma:** `next build` fallaba con `Object literal may only specify known properties, and 'organization_id' does not exist in type 'never[]'` en TODAS las llamadas a `.insert(...)` y `.update(...)` del data layer. `tsc --noEmit` reportaba ~30 errores idénticos. El cliente reportaba el shape interno `PostgrestVersion: "12"` con `never` en todas las posiciones.
- **Causa raíz:** la versión de `@supabase/supabase-js` fijada en `package.json` (`2.105.4`) introdujo una forma interna estricta para el generic `Database` que espera, además de `Row/Insert/Update`, los campos `Relationships: []` por cada tabla y un marker `__InternalSupabase: { PostgrestVersion: "12" }` a nivel raíz. La forma hand-written de `lib/types/database.ts` (que omite ambos) hace que el resolver de tipos colapse cada tabla a `never`, lo que rompe el inserto/update.
- **Workaround / fix:** se removió el generic `Database` de los tres clientes (`admin.ts`, `browser.ts`, `server.ts`) — el cliente queda como `SupabaseClient` sin parametrizar. Los tipos fuertes de los resultados siguen viniendo de `lib/types/database.ts` y se aplican como tipos de retorno explícitos en cada función del data layer (los Row types funcionan perfectamente — el problema era solo en las llamadas tipadas del client builder).
- **Lección:** los tipos fuertes del cliente Supabase deben generarse con `supabase gen types typescript` para casar con la shape interna que cada versión espera. Hand-writing el `Database` type es viable solo en versiones más viejas (≤2.50). En M11 o cuando el operador habilite el Supabase CLI, regenerar `lib/types/database.ts` desde el schema real y restaurar el generic en los clientes. Hasta entonces, mantener el patrón actual (clientes sin generic + Row types como retorno explícito).
