import "server-only";
import { getInngestClient } from "@/lib/inngest/client";
import { withTenantContext } from "@/lib/tenant/context";
import { listAllOrganizationIds } from "@/lib/db/organizations";
import { getTenantScopedClient } from "@/lib/db/client";
import { recordAuditEvent, createNotification } from "@/lib/db/operational";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Json, UUID } from "@/lib/types/database";

/**
 * Monitoreo de salud del inbound Whaapy (cron horario).
 *
 * El DLQ handler ya notifica por-fallo, pero se pierde entre el ruido (26
 * outbound + Shopify DLQs) — por eso un fallo SISTEMÁTICO (100% de un topic
 * por drift de schema, como `conversation.created` fallando 66 veces) pasó
 * semanas sin que nadie actuara. Este cron AGREGA: si un topic inbound falló
 * ≥ umbral en la última hora, emite UNA alerta de alta señal (posible cambio
 * de formato del payload), con cooldown para no repetir cada hora.
 *
 * Cada hora (CLAUDE.md "Crons operativos cada hora"). TZ America/Mexico_City.
 */

const inngest = getInngestClient();

const WINDOW_MIN = 65; // ventana de conteo (ligeramente > 1h para no perder bordes)
const ALERT_THRESHOLD = 3; // ≥3 fallos del mismo topic en la ventana = sistemático
const COOLDOWN_HOURS = 6; // no repetir la alerta del mismo topic antes de esto

export const whaapyInboundHealthCron = inngest.createFunction(
  {
    id: "whaapy-inbound-health-check",
    retries: 2,
    triggers: [{ cron: "TZ=America/Mexico_City 0 * * * *" }],
  },
  async () => {
    // Nota: `Date` está disponible en workers Inngest (a diferencia de los
    // scripts de Workflow). El cron se dispara cada hora; el instante exacto
    // no afecta la corrección (ventana deslizante).
    const now = Date.now();
    const sinceIso = new Date(now - WINDOW_MIN * 60_000).toISOString();
    const cooldownIso = new Date(now - COOLDOWN_HOURS * 3_600_000).toISOString();

    const orgIds = await listAllOrganizationIds();
    let alertsRaised = 0;

    for (const orgId of orgIds) {
      try {
        await withTenantContext(
          orgId,
          async () => {
            const { supabase } = getTenantScopedClient();

            // Fallos de webhook inbound Whaapy en la ventana, agrupados por topic.
            const { data: fails, error } = await supabase
              .from("audit_log")
              .select("payload")
              .eq("organization_id", orgId)
              .eq("event_type", "whaapy_webhook_failed")
              .gte("created_at", sinceIso)
              .limit(2000);
            if (error) throw error;

            const byTopic = new Map<string, { count: number; sample: string }>();
            for (const row of (fails ?? []) as Array<{ payload: Record<string, unknown> }>) {
              const topic = String(row.payload?.topic ?? "unknown");
              const prev = byTopic.get(topic) ?? { count: 0, sample: "" };
              prev.count += 1;
              if (!prev.sample) prev.sample = String(row.payload?.error ?? "").slice(0, 300);
              byTopic.set(topic, prev);
            }

            const systematic = Array.from(byTopic.entries()).filter(
              ([, v]) => v.count >= ALERT_THRESHOLD,
            );
            if (systematic.length === 0) return;

            // Cooldown: alertas recientes por topic (evita repetir cada hora).
            const { data: recentAlerts } = await supabase
              .from("audit_log")
              .select("payload")
              .eq("organization_id", orgId)
              .eq("event_type", "whaapy_inbound_health_alert")
              .gte("created_at", cooldownIso)
              .limit(200);
            const recentTopics = new Set(
              ((recentAlerts ?? []) as Array<{ payload: Record<string, unknown> }>).map((r) =>
                String(r.payload?.topic ?? ""),
              ),
            );

            const admin = getSupabaseAdminClient();
            const { data: admins } = await admin
              .from("memberships")
              .select("user_id")
              .eq("organization_id", orgId)
              .eq("role", "admin")
              .eq("is_active", true);

            for (const [topic, v] of systematic) {
              if (recentTopics.has(topic)) continue; // en cooldown
              await recordAuditEvent({
                actorUserId: null,
                eventType: "whaapy_inbound_health_alert",
                entityType: "organization",
                entityId: orgId,
                payload: {
                  topic,
                  failures_in_window: v.count,
                  window_minutes: WINDOW_MIN,
                  sample_error: v.sample,
                } as Json,
              });
              for (const adm of admins ?? []) {
                await createNotification({
                  user_id: (adm as { user_id: UUID }).user_id,
                  notification_type: "whaapy_inbound_failing",
                  origin: "system",
                  origin_reference: { topic, failures: v.count } as Json,
                  opportunity_id: null,
                  contact_id: null,
                  title: "Sincronización inbound Whaapy con fallos",
                  message:
                    `El evento "${topic}" de Whaapy falló ${v.count} veces en la última hora ` +
                    `— posible cambio de formato del payload. Revisar (contactos/asignaciones ` +
                    `nuevos podrían no estar llegando a la plataforma).`,
                  amount_at_stake: null,
                  due_at: null,
                  status: "pending",
                  snoozed_until: null,
                  schema_version: "1",
                  completed_at: null,
                });
              }
              alertsRaised += 1;
            }
          },
          { source: "worker" },
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`whaapy-inbound-health: org ${orgId} falló:`, (err as Error).message);
      }
    }

    return { organizations: orgIds.length, alertsRaised };
  },
);

export const whaapyInboundHealthFunctions = [whaapyInboundHealthCron];
