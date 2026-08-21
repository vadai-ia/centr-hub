/* eslint-disable no-console */
/**
 * HARNESS de prueba end-to-end del mensaje de Post-venta.
 *
 * Reproduce EXACTAMENTE lo que la plataforma hace en producción cuando una
 * oportunidad llega a una etapa de Post-venta: busca (o crea) el contacto en
 * el Whaapy de Post-venta por teléfono, le escribe los `custom_fields` con el
 * contexto del pedido, y lo MUEVE a la etapa destino. El mensaje NO lo manda
 * este script — lo dispara la Automation de Whaapy sobre esa etapa, igual que
 * en producción.
 *
 * Por eso es la única prueba que valida las tres cosas a la vez:
 *   1. que la Automation dispara al entrar a la etapa,
 *   2. que el template resuelve sus variables desde los custom_fields,
 *   3. cómo se ve el mensaje ya renderizado en WhatsApp.
 *
 * La vista previa del dashboard solo cubre (3), con valores de ejemplo.
 *
 * ⚠️ MANDA UN WHATSAPP REAL al número que le pases. Usa tu propio número.
 * Exige `--phone` explícito (sin default) y `--dry-run` no escribe nada.
 *
 * Scopes: solo contacts:read/write + funnels:read/write — los que ya tienen
 * todas las instancias. No necesita `messages` porque no envía.
 *
 * Uso:
 *   npm run whaapy:harness-postventa-message -- --org-slug centr --phone +5215512345678 --dry-run
 *   npm run whaapy:harness-postventa-message -- --org-slug centr --phone +5215512345678 \
 *     --order-ref "#1728" --name "Jorge Prueba" --stage entregado
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { withTenantContext } from "@/lib/tenant/context";
import {
  createPostventaContact,
  findPostventaContactByPhone,
  movePostventaContactToStage,
  patchPostventaContactCustomFields,
  resolvePostventaStageIdByKey,
} from "@/lib/whaapy-postventa/api";
import {
  WHAAPY_POSTVENTA_CUSTOM_FIELDS,
  WHAAPY_POSTVENTA_STAGE_NAMES,
  type WhaapyPostventaStageKey,
} from "@/lib/whaapy-postventa/config";
import { normalizePhone } from "@/lib/services/identity-matching";
import type { UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const DRY_RUN = process.argv.includes("--dry-run");

const STAGE_KEYS = Object.keys(WHAAPY_POSTVENTA_STAGE_NAMES) as WhaapyPostventaStageKey[];

async function main() {
  const slug = arg("--org-slug");
  const rawPhone = arg("--phone");
  const stageKey = (arg("--stage", "entregado") ?? "entregado") as WhaapyPostventaStageKey;
  const orderRef = arg("--order-ref", "#PRUEBA-1728")!;
  const name = arg("--name", "Prueba Centr Hub")!;

  if (!slug || !rawPhone) {
    console.error(
      'Uso: --org-slug centr --phone +5215512345678 [--stage entregado] [--order-ref "#1728"] [--name "..."] [--dry-run]',
    );
    console.error(`Etapas válidas: ${STAGE_KEYS.join(", ")}`);
    process.exit(1);
  }
  if (!STAGE_KEYS.includes(stageKey)) {
    console.error(`--stage inválido. Válidas: ${STAGE_KEYS.join(", ")}`);
    process.exit(1);
  }

  // Mismo normalizador que usa el push productivo: si acá no pasa, en
  // producción tampoco pasaría.
  const phone = normalizePhone(rawPhone);
  if (!phone) {
    console.error(`Teléfono inválido: "${rawPhone}". Usa formato E.164 (+52...).`);
    process.exit(1);
  }

  const org = await getOrganizationBySlug(slug);
  if (!org) {
    console.error(`org "${slug}" no encontrada`);
    process.exit(1);
  }

  await withTenantContext(
    org.id as UUID,
    async () => {
      const orgId = org.id as UUID;
      const stageName = WHAAPY_POSTVENTA_STAGE_NAMES[stageKey];

      const stageId = await resolvePostventaStageIdByKey(orgId, stageKey);
      if (!stageId) {
        console.error(
          `✗ La etapa "${stageName}" no existe en el funnel de Post-venta de ${slug}.\n` +
            `  Créala primero:  npm run whaapy:ensure-postventa-stages -- --org-slug ${slug}`,
        );
        process.exit(1);
      }

      const customFields = {
        [WHAAPY_POSTVENTA_CUSTOM_FIELDS.opportunityId]: "harness-prueba",
        [WHAAPY_POSTVENTA_CUSTOM_FIELDS.orderRef]: orderRef,
        [WHAAPY_POSTVENTA_CUSTOM_FIELDS.orderId]: "harness-prueba",
      };

      const match = await findPostventaContactByPhone(orgId, phone);

      console.log(`\n=== PRUEBA de mensaje Post-venta — ${slug} ===\n`);
      console.log(`  teléfono      : ${phone}`);
      console.log(`  etapa destino : "${stageName}"  (${stageId})`);
      console.log(`  custom_fields : ${JSON.stringify(customFields)}`);
      console.log(
        `  contacto      : ${match ? `existe (${match.contactId}), etapa actual ${match.currentStageId ?? "ninguna"}` : "NO existe → se creará"}`,
      );

      // Whaapy no re-dispara la automatización si el contacto ya está en la
      // etapa destino: el trigger es ENTRAR, no estar. Sin este aviso, la
      // prueba "no manda nada" y parece que la Automation está rota.
      if (match && match.currentStageId === stageId) {
        console.log(
          `\n⚠  El contacto YA está en "${stageName}". Whaapy no vuelve a disparar la\n` +
            `   automatización (el trigger es ENTRAR a la etapa). Muévelo a otra etapa\n` +
            `   desde el dashboard y vuelve a correr esto.`,
        );
        return;
      }

      if (DRY_RUN) {
        console.log(`\n(dry run) Nada escrito. Quitá --dry-run para ejecutar.\n`);
        return;
      }

      let contactId: string;
      if (match) {
        contactId = match.contactId;
        await patchPostventaContactCustomFields(orgId, contactId, customFields);
        console.log(`\n✓ custom_fields actualizados en ${contactId}`);
      } else {
        contactId = await createPostventaContact(orgId, {
          name,
          phoneE164: phone,
          email: null,
          customFields,
        });
        console.log(`\n✓ contacto creado: ${contactId}`);
      }

      await movePostventaContactToStage(orgId, contactId, stageId);
      console.log(`✓ movido a "${stageName}" → la Automation debería disparar ahora.`);
      console.log(`\nRevisa el WhatsApp de ${phone}.`);
      console.log(`Si NO llega nada, revisa en este orden:`);
      console.log(`  1. ¿Existe una Automation con trigger pipeline_stage_entered en "${stageName}"?`);
      console.log(`  2. ¿Su acción send_template apunta al template correcto y está APROBADO?`);
      console.log(`  3. Si llega pero con la variable vacía, la Automation no está leyendo`);
      console.log(`     el custom field "${WHAAPY_POSTVENTA_CUSTOM_FIELDS.orderRef}".`);
    },
    { source: "script" },
  );
}

main().catch((e: Error) => {
  console.error("falló:", e.message);
  process.exit(1);
});
