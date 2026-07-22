"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenantContext } from "@/lib/tenant/context";
import { resolveAdminContext } from "@/lib/auth/admin-guard";
import {
  createInboundWebhookSource,
  getInboundWebhookSourceById,
  listInboundWebhookSources,
  rotateInboundWebhookSourceToken,
  setInboundWebhookSourceActive,
} from "@/lib/db/inbound-webhook-sources";
import {
  generateWebhookSlug,
  generateWebhookToken,
  hashWebhookToken,
  tokenLast4,
} from "@/lib/services/webhook-token";
import type { InboundWebhookSourceRow } from "@/lib/types/database";

/**
 * Server actions de administración de fuentes de webhook de leads (0038,
 * Bloque B). SOLO admin/superadmin. El token se muestra UNA vez al crear o
 * rotar (viene en el resultado); nunca se puede recuperar después (en BD
 * solo vive su hash — patrón "copiar ahora").
 */

export type WebhookSourceListResult =
  | { ok: true; sources: InboundWebhookSourceRow[] }
  | { ok: false; message: string };

export type WebhookSourceCreateResult =
  | {
      ok: true;
      source: InboundWebhookSourceRow;
      /** Token crudo — se muestra 1 sola vez. */
      token: string;
      endpointUrl: string;
      sources: InboundWebhookSourceRow[];
    }
  | { ok: false; message: string };

export type WebhookSourceRotateResult =
  | { ok: true; source: InboundWebhookSourceRow; token: string; endpointUrl: string; sources: InboundWebhookSourceRow[] }
  | { ok: false; message: string };

function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

function endpointUrlFor(slug: string): string {
  return `${siteUrl()}/api/webhooks/leads/${slug}`;
}

export async function loadInboundWebhookSources(): Promise<WebhookSourceListResult> {
  const admin = await resolveAdminContext();
  if (!admin.ok) return admin;
  return withTenantContext(
    admin.ctx.orgId,
    async () => ({ ok: true as const, sources: await listInboundWebhookSources() }),
    { source: "user_session" },
  );
}

const createSchema = z.object({ name: z.string().trim().min(1).max(120) });

export async function createInboundWebhookSourceAction(
  raw: unknown,
): Promise<WebhookSourceCreateResult> {
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Nombre de la fuente inválido." };
  const admin = await resolveAdminContext();
  if (!admin.ok) return admin;

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const slug = generateWebhookSlug();
      const token = generateWebhookToken();
      const source = await createInboundWebhookSource({
        name: parsed.data.name,
        slug,
        tokenHash: hashWebhookToken(token),
        tokenLast4: tokenLast4(token),
        createdByUserId: admin.ctx.userId,
      });
      revalidatePath("/admin/webhooks");
      return {
        ok: true as const,
        source,
        token,
        endpointUrl: endpointUrlFor(slug),
        sources: await listInboundWebhookSources(),
      };
    },
    { source: "user_session" },
  );
}

const idSchema = z.object({ id: z.string().uuid() });

export async function rotateInboundWebhookSourceTokenAction(
  raw: unknown,
): Promise<WebhookSourceRotateResult> {
  const parsed = idSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Identificador inválido." };
  const admin = await resolveAdminContext();
  if (!admin.ok) return admin;

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const existing = await getInboundWebhookSourceById(parsed.data.id);
      if (!existing) return { ok: false as const, message: "La fuente no existe." };
      const token = generateWebhookToken();
      const source = await rotateInboundWebhookSourceToken(
        parsed.data.id,
        hashWebhookToken(token),
        tokenLast4(token),
        new Date().toISOString(),
      );
      revalidatePath("/admin/webhooks");
      return {
        ok: true as const,
        source,
        token,
        endpointUrl: endpointUrlFor(source.slug),
        sources: await listInboundWebhookSources(),
      };
    },
    { source: "user_session" },
  );
}

const setActiveSchema = z.object({ id: z.string().uuid(), isActive: z.boolean() });

export async function setInboundWebhookSourceActiveAction(
  raw: unknown,
): Promise<WebhookSourceListResult> {
  const parsed = setActiveSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Datos inválidos." };
  const admin = await resolveAdminContext();
  if (!admin.ok) return admin;

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const existing = await getInboundWebhookSourceById(parsed.data.id);
      if (!existing) return { ok: false as const, message: "La fuente no existe." };
      await setInboundWebhookSourceActive(parsed.data.id, parsed.data.isActive);
      revalidatePath("/admin/webhooks");
      return { ok: true as const, sources: await listInboundWebhookSources() };
    },
    { source: "user_session" },
  );
}
