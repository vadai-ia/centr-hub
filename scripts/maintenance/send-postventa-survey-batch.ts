/* eslint-disable no-console */
/**
 * Envío ÚNICO de la encuesta de Post-venta a clientes que YA están en
 * "Seguimiento post-entrega" pero nunca la recibieron.
 *
 * Por qué existe y no basta el flujo normal: el cron de los 7 días cuenta
 * desde `delivery_message_sent_at`, y estos clientes llegaron a esa etapa
 * ANTES de que existieran los mensajes — se movieron a mano, sin aviso de
 * entrega previo. Para el cron nunca van a estar "vencidos", así que sin
 * este correctivo no la recibirían jamás. Post-venta lo pidió explícitamente.
 *
 * Decisiones que protegen al cliente (no son opciones, son el contrato):
 *
 * - **Una por PERSONA, no por tarjeta.** Hay clientes con varias compras en
 *   la etapa; mandar por tarjeta les llegaría la misma encuesta dos o tres
 *   veces el mismo día. Se agrupa por contacto y se sella cada tarjeta suya.
 * - **Nadie con entrega en curso.** Preguntarle "¿ya estás disfrutando tu
 *   equipo?" a quien sigue esperando el paquete es peor que no escribir.
 *   Exige `orders.delivery_status = 'delivered'` en al menos un pedido.
 * - **Se sella `followup_message_sent_at`** al enviar: el CRM muestra el
 *   badge y una segunda corrida no reescribe a nadie (idempotente).
 * - **`--limit` para mandar en tandas.** Es una plantilla de MARKETING: un
 *   pico de reportes o bloqueos baja la calificación de la WABA y eso
 *   degrada TODOS los envíos futuros, incluidas las confirmaciones de
 *   entrega. Mejor 20-30 al día que 100 de golpe.
 *
 * `--incluir-entregado` amplía el criterio a las tarjetas que siguen en
 * "Entregado": Post-venta pidió alcanzar a TODA compra del periodo cuyo
 * paquete ya llegó, no solo a las que alguien movió de columna. Quedan fuera
 * igual los casos problemáticos y las que YA están en el ciclo automático
 * (con mensaje de entrega enviado): a esas la encuesta les toca a sus 7 días,
 * y adelantarla les mandaría dos mensajes en dos días.
 *
 * Uso:
 *   npm run maintenance:send-postventa-survey -- --org-slug centr --desde 2026-09-01
 *   npm run maintenance:send-postventa-survey -- --org-slug centr --desde 2026-09-01 --incluir-entregado
 *   npm run maintenance:send-postventa-survey -- --org-slug centr --desde 2026-09-01 --limit 5 --apply
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { withTenantContext } from "@/lib/tenant/context";
import { updateOpportunity } from "@/lib/db/opportunities";
import { recordAuditEvent } from "@/lib/db/operational";
import { sendPostventaTemplate } from "@/lib/whaapy-postventa/send-template";
import { POSTVENTA_SURVEY_TEMPLATE } from "@/lib/whaapy-postventa/config";
import { normalizePhone } from "@/lib/services/identity-matching";
import type { Json, UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const APPLY = process.argv.includes("--apply");
const INCLUIR_ENTREGADO = process.argv.includes("--incluir-entregado");

interface Candidato {
  contactId: UUID;
  nombre: string;
  telefono: string;
  oppIds: UUID[];
  pedidos: string[];
}

async function main() {
  const slug = arg("--org-slug");
  const desde = arg("--desde");
  if (!slug || !desde) {
    console.error('Uso: --org-slug centr --desde 2026-09-01 [--limit N] [--apply]');
    process.exit(1);
  }
  const limit = Number(arg("--limit") ?? "1000");

  const org = await getOrganizationBySlug(slug);
  if (!org) {
    console.error(`org "${slug}" no encontrada`);
    process.exit(1);
  }

  await withTenantContext(
    org.id as UUID,
    async () => {
      const admin = getSupabaseAdminClient();

      const nombresEtapa = INCLUIR_ENTREGADO
        ? ["Seguimiento post-entrega", "Entregado"]
        : ["Seguimiento post-entrega"];
      const { data: stages, error: stageErr } = await admin
        .from("pipeline_stages")
        .select("id, name")
        .eq("organization_id", org.id)
        .eq("funnel", "post_venta")
        .in("name", nombresEtapa);
      if (stageErr) throw new Error(`etapa: ${stageErr.message}`);
      if (!stages || stages.length !== nombresEtapa.length) {
        throw new Error(`faltan etapas de Post-venta: ${nombresEtapa.join(", ")}`);
      }
      const stageIds = stages.map((x) => x.id);

      const { data: opps, error: oppErr } = await admin
        .from("opportunities")
        .select("id, contact_id, shopify_order_id, delivery_message_sent_at")
        .eq("organization_id", org.id)
        .in("stage_id", stageIds)
        .is("cancelled_at", null)
        .is("resolved_at", null)
        .is("followup_message_sent_at", null);
      if (oppErr) throw new Error(`opps: ${oppErr.message}`);

      const oids = (opps ?? []).map((o) => o.shopify_order_id).filter(Boolean) as string[];
      const { data: ords, error: ordErr } = await admin
        .from("orders")
        .select("shopify_order_id, shopify_name, paid_at, delivery_status")
        .eq("organization_id", org.id)
        .in("shopify_order_id", oids.length > 0 ? oids : ["__none__"]);
      if (ordErr) throw new Error(`orders: ${ordErr.message}`);
      const byOid = new Map((ords ?? []).map((o) => [o.shopify_order_id, o]));

      const { data: contacts, error: cErr } = await admin
        .from("contacts")
        .select("id, full_name, phone")
        .eq("organization_id", org.id)
        .in("id", Array.from(new Set((opps ?? []).map((o) => o.contact_id))));
      if (cErr) throw new Error(`contacts: ${cErr.message}`);
      const byContact = new Map((contacts ?? []).map((c) => [c.id, c]));

      // Agrupar por persona, quedándose solo con entregas confirmadas.
      const porPersona = new Map<UUID, Candidato>();
      const descartes = {
        sin_telefono: 0,
        sin_entrega_confirmada: 0,
        antes_del_corte: 0,
        ya_en_ciclo_automatico: 0,
      };
      for (const opp of opps ?? []) {
        // Ya recibió el aviso de entrega: su encuesta sale sola a los 7 días.
        // Adelantarla aquí le mandaría dos mensajes con un día de diferencia.
        if (opp.delivery_message_sent_at) {
          descartes.ya_en_ciclo_automatico += 1;
          continue;
        }
        const ord = opp.shopify_order_id ? byOid.get(opp.shopify_order_id) : null;
        if (!ord || String(ord.paid_at ?? "") < desde) {
          descartes.antes_del_corte += 1;
          continue;
        }
        if (ord.delivery_status !== "delivered") {
          descartes.sin_entrega_confirmada += 1;
          continue;
        }
        const contact = byContact.get(opp.contact_id);
        const phone = normalizePhone(contact?.phone ?? null);
        if (!contact || !phone) {
          descartes.sin_telefono += 1;
          continue;
        }
        const previo = porPersona.get(contact.id as UUID);
        if (previo) {
          previo.oppIds.push(opp.id as UUID);
          previo.pedidos.push(ord.shopify_name ?? "?");
          continue;
        }
        porPersona.set(contact.id as UUID, {
          contactId: contact.id as UUID,
          nombre: contact.full_name ?? "(sin nombre)",
          telefono: phone,
          oppIds: [opp.id as UUID],
          pedidos: [ord.shopify_name ?? "?"],
        });
      }

      const candidatos = Array.from(porPersona.values()).slice(0, limit);
      console.log(`\n=== Encuesta de Post-venta · ${slug} · pedidos desde ${desde} ===\n`);
      console.log(`  personas a las que se enviaría: ${candidatos.length} (de ${porPersona.size} elegibles)`);
      console.log(
        `  etapas consideradas: ${nombresEtapa.join(" + ")}`,
      );
      console.log(
        `  descartadas: ${descartes.antes_del_corte} antes del corte · ` +
          `${descartes.sin_entrega_confirmada} sin entrega confirmada · ` +
          `${descartes.sin_telefono} sin teléfono · ` +
          `${descartes.ya_en_ciclo_automatico} ya en el ciclo automático\n`,
      );
      for (const c of candidatos) {
        console.log(`   ${c.nombre.padEnd(34)} ${c.telefono.padEnd(16)} ${c.pedidos.join(", ")}`);
      }

      if (!APPLY) {
        console.log(`\n(simulación) Nada enviado. Agrega --apply para mandar.\n`);
        return;
      }

      let enviados = 0;
      for (const c of candidatos) {
        try {
          await sendPostventaTemplate(org.id as UUID, {
            to: c.telefono,
            templateName: POSTVENTA_SURVEY_TEMPLATE,
            parameters: [primerNombre(c.nombre)],
          });
        } catch (error) {
          // Un teléfono muerto no debe abortar la tanda completa.
          console.error(`   ✗ ${c.nombre}: ${(error as Error).message}`);
          continue;
        }
        const nowIso = new Date().toISOString();
        for (const oppId of c.oppIds) {
          await updateOpportunity(oppId, { followup_message_sent_at: nowIso });
          await recordAuditEvent({
            actorUserId: null,
            eventType: "postventa_survey_backfill_sent",
            entityType: "opportunity",
            entityId: oppId,
            payload: { contact_id: c.contactId, phone_last4: c.telefono.slice(-4) } as Json,
          });
        }
        enviados += 1;
        console.log(`   ✓ ${c.nombre}`);
      }
      console.log(`\n✓ enviados: ${enviados} de ${candidatos.length}\n`);
    },
    { source: "script" },
  );
}

function primerNombre(nombre: string): string {
  const first = nombre.trim().split(/\s+/)[0];
  return first || "Hola";
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
