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
- **Lección:** Supabase Auth tiene **dos flujos distintos en Next.js App Router**: (a) **PKCE** (`?code=` → `exchangeCodeForSession` en Route Handler o Server Component) y (b) **Implícito** (`#access_token=` → sólo accesible client-side). Las invitaciones y password recovery de Supabase usan el flujo implícito con hash fragment. Un Route Handler nunca puede manejarlos directamente. La técnica correcta es servir desde el Route Handler un HTML mínimo que haga el redirect client-side con `window.location.replace`, preservando el hash. La nueva página `/auth/confirm` actúa como landing unificado para todos los flujos de hash.

### supabase-js 2.105 — Database type hand-written incompatible con shape estricta

- **Milestone donde se detectó:** M1.
- **Síntoma:** `next build` fallaba con `Object literal may only specify known properties, and 'organization_id' does not exist in type 'never[]'` en TODAS las llamadas a `.insert(...)` y `.update(...)` del data layer. `tsc --noEmit` reportaba ~30 errores idénticos. El cliente reportaba el shape interno `PostgrestVersion: "12"` con `never` en todas las posiciones.
- **Causa raíz:** la versión de `@supabase/supabase-js` fijada en `package.json` (`2.105.4`) introdujo una forma interna estricta para el generic `Database` que espera, además de `Row/Insert/Update`, los campos `Relationships: []` por cada tabla y un marker `__InternalSupabase: { PostgrestVersion: "12" }` a nivel raíz. La forma hand-written de `lib/types/database.ts` (que omite ambos) hace que el resolver de tipos colapse cada tabla a `never`, lo que rompe el inserto/update.
- **Workaround / fix:** se removió el generic `Database` de los tres clientes (`admin.ts`, `browser.ts`, `server.ts`) — el cliente queda como `SupabaseClient` sin parametrizar. Los tipos fuertes de los resultados siguen viniendo de `lib/types/database.ts` y se aplican como tipos de retorno explícitos en cada función del data layer (los Row types funcionan perfectamente — el problema era solo en las llamadas tipadas del client builder).
- **Lección:** los tipos fuertes del cliente Supabase deben generarse con `supabase gen types typescript` para casar con la shape interna que cada versión espera. Hand-writing el `Database` type es viable solo en versiones más viejas (≤2.50). En M11 o cuando el operador habilite el Supabase CLI, regenerar `lib/types/database.ts` desde el schema real y restaurar el generic en los clientes. Hasta entonces, mantener el patrón actual (clientes sin generic + Row types como retorno explícito).
