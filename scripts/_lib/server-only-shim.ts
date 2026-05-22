// Shim para `server-only` cuando los scripts CLI corren con tsx fuera
// del runtime de Next.js. El paquete real `server-only` solo está disponible
// dentro de `node_modules/next/dist/compiled/server-only` (Next.js lo aliasea
// en build); al ejecutar con tsx, Node no lo encuentra y la importación
// `import "server-only"` en `lib/supabase/admin.ts` revienta con
// `Cannot find module 'server-only'`.
//
// Este archivo se mapea como `server-only` vía `scripts/tsconfig.json`
// para que el `import` de admin.ts resuelva a un módulo vacío durante la
// ejecución de scripts. La protección original sigue activa en Next.js
// (el bundler usa el `server-only` real y emite build-error si un Client
// Component lo importa).
export {};
