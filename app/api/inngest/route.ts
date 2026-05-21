import { serve } from "inngest/next";
import { getInngestClient } from "@/lib/inngest/client";
import { allFunctions } from "@/lib/inngest/functions";

/**
 * Endpoint de Inngest (M3). Sirve el manifest GET para registro
 * en el dashboard y procesa los eventos vía POST con signing key.
 *
 * NOTA: Vercel free limita Function duration. Para workers
 * pesados (Bulk Operations Shopify, exports PDF) usar
 * `step.invoke` desde la propia Inngest function — no agregar
 * lógica long-running directamente al body.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, POST, PUT } = serve({
  client: getInngestClient(),
  functions: allFunctions,
});
