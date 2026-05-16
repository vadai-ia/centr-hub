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

### supabase-js 2.105 — Database type hand-written incompatible con shape estricta

- **Milestone donde se detectó:** M1.
- **Síntoma:** `next build` fallaba con `Object literal may only specify known properties, and 'organization_id' does not exist in type 'never[]'` en TODAS las llamadas a `.insert(...)` y `.update(...)` del data layer. `tsc --noEmit` reportaba ~30 errores idénticos. El cliente reportaba el shape interno `PostgrestVersion: "12"` con `never` en todas las posiciones.
- **Causa raíz:** la versión de `@supabase/supabase-js` fijada en `package.json` (`2.105.4`) introdujo una forma interna estricta para el generic `Database` que espera, además de `Row/Insert/Update`, los campos `Relationships: []` por cada tabla y un marker `__InternalSupabase: { PostgrestVersion: "12" }` a nivel raíz. La forma hand-written de `lib/types/database.ts` (que omite ambos) hace que el resolver de tipos colapse cada tabla a `never`, lo que rompe el inserto/update.
- **Workaround / fix:** se removió el generic `Database` de los tres clientes (`admin.ts`, `browser.ts`, `server.ts`) — el cliente queda como `SupabaseClient` sin parametrizar. Los tipos fuertes de los resultados siguen viniendo de `lib/types/database.ts` y se aplican como tipos de retorno explícitos en cada función del data layer (los Row types funcionan perfectamente — el problema era solo en las llamadas tipadas del client builder).
- **Lección:** los tipos fuertes del cliente Supabase deben generarse con `supabase gen types typescript` para casar con la shape interna que cada versión espera. Hand-writing el `Database` type es viable solo en versiones más viejas (≤2.50). En M11 o cuando el operador habilite el Supabase CLI, regenerar `lib/types/database.ts` desde el schema real y restaurar el generic en los clientes. Hasta entonces, mantener el patrón actual (clientes sin generic + Row types como retorno explícito).
