import { describe, expect, it } from "vitest";
import {
  WhaapyContactCreatedPayloadSchema,
  WhaapyContactUpdatedPayloadSchema,
  WhaapyContactDeletedPayloadSchema,
  WhaapyConversationCreatedPayloadSchema,
  WhaapyConversationAssignedPayloadSchema,
  WhaapyConversationUnassignedPayloadSchema,
  WhaapyConversationClosedPayloadSchema,
  WhaapyContactGetResponseSchema,
  extractBusinessId,
  extractTopic,
  extractTimestamp,
} from "@/lib/whaapy/mappers";

/**
 * Unit tests de los Zod schemas de Whaapy. Los schemas viven en
 * `lib/whaapy/mappers.ts` y los workers de M4 los invocan vía
 * `Schema.parse(envelope.payload)` (ver `lib/inngest/functions/
 * whaapy-contacts.ts` y `whaapy-conversations.ts`).
 *
 * El test de endpoint (`whaapy-webhook-endpoint.test.ts`) solo
 * cubre routing/HMAC/dedup — el endpoint NO ejecuta el schema. La
 * validación profunda corre dentro del worker. Sin estos tests, un
 * payload real que rompa el schema solo se descubre en producción
 * vía `audit_log` (`whaapy_webhook_failed`) tras agotar los 5 retries
 * de Inngest. Patrón documentado en ERRORES.md tras el bug
 * "Schemas Zod inbound Whaapy intolerantes a omisiones de campos
 * opcionales".
 */

describe("WhaapyContactCreatedPayloadSchema", () => {
  it("payload real mínimo (contacto sin address ni email cargados) — el caso que rompió producción", () => {
    // Capturado del log de Whaapy 2026-05-22 — contacto creado solo
    // con nombre + teléfono. `address` está OMITIDO (no aparece),
    // `email` viene como `null` explícito, `tags` como array vacío.
    const realPayload = {
      data: {
        name: "Pruebas Vadai 2",
        tags: [],
        email: null,
        contact_id: "70dece15-5969-4992-b362-ade13df4bbe5",
        created_at: "2026-05-22T22:13:17.792Z",
        phone_number: "525561168236",
      },
      event: "contact.created",
      timestamp: "2026-05-22T23:53:00.089Z",
      businessId: "1db0bff4-e554-4a07-9585-faaf93b401f4",
    };

    const result = WhaapyContactCreatedPayloadSchema.safeParse(realPayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.businessId).toBe("1db0bff4-e554-4a07-9585-faaf93b401f4");
      expect(result.data.data.contact_id).toBe("70dece15-5969-4992-b362-ade13df4bbe5");
      expect(result.data.data.email).toBe(null);
      expect(result.data.data.tags).toEqual([]);
      // `address` omitido se preserva como undefined, no truena en parse.
      expect(result.data.data.address).toBeUndefined();
    }
  });

  it("payload completo con todos los campos opcionales presentes — no regresar caso opuesto", () => {
    const completePayload = {
      data: {
        name: "Contacto Completo",
        tags: ["VIP", "Recurrente"],
        email: "completo@example.com",
        contact_id: "abc-123",
        created_at: "2026-05-22T22:13:17.792Z",
        updated_at: "2026-05-22T22:13:17.792Z",
        phone_number: "525500000000",
        wa_id: "wa-525500000000",
        source: "manual",
        assigned_agent_id: "agent-1",
        custom_fields: { last_platform_write_at: "2026-05-22T22:00:00Z" },
        address: {
          street: "Calle 1",
          city: "CDMX",
          state: "CDMX",
          country: "MX",
          zip: "01000",
        },
      },
      event: "contact.created",
      timestamp: "2026-05-22T22:13:17.792Z",
      businessId: "biz-1",
    };

    const result = WhaapyContactCreatedPayloadSchema.safeParse(completePayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.data.address).toMatchObject({ street: "Calle 1", city: "CDMX" });
      expect(result.data.data.custom_fields).toMatchObject({
        last_platform_write_at: "2026-05-22T22:00:00Z",
      });
    }
  });

  it("address explícito como null — Whaapy podría enviarlo si limpiamos la dirección", () => {
    const payload = {
      data: { contact_id: "x", address: null },
      event: "contact.created",
      timestamp: "2026-05-22T22:13:17.792Z",
      businessId: "biz-1",
    };
    const result = WhaapyContactCreatedPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.data.address).toBe(null);
    }
  });

  it("falta businessId en root → falla (es required para tenant resolution)", () => {
    const payload = {
      data: { contact_id: "x" },
      event: "contact.created",
      // sin businessId
    };
    const result = WhaapyContactCreatedPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("falta data.contact_id → falla (es required para identidad)", () => {
    const payload = {
      data: { name: "X" },
      event: "contact.created",
      businessId: "biz-1",
    };
    const result = WhaapyContactCreatedPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("campos extra en data → preservados vía passthrough (Whaapy puede agregar campos sin rompernos)", () => {
    const payload = {
      data: {
        contact_id: "x",
        funnel_stage_id: "stage-42",
        avatar_url: "https://example.com/a.png",
      },
      event: "contact.created",
      businessId: "biz-1",
    };
    const result = WhaapyContactCreatedPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data.data as Record<string, unknown>;
      expect(data.funnel_stage_id).toBe("stage-42");
      expect(data.avatar_url).toBe("https://example.com/a.png");
    }
  });
});

describe("WhaapyContactUpdatedPayloadSchema", () => {
  it("payload delta mínimo — Whaapy solo manda updated_fields + name + previous_name", () => {
    const payload = {
      data: {
        contact_id: "c1",
        updated_fields: ["name"],
        name: "Nuevo Nombre",
        previous_name: "Viejo Nombre",
      },
      event: "contact.updated",
      timestamp: "2026-05-22T22:13:17.792Z",
      businessId: "biz-1",
    };
    const result = WhaapyContactUpdatedPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("payload delta sin updated_fields → default [] aplicado", () => {
    const payload = {
      data: { contact_id: "c1" },
      event: "contact.updated",
      businessId: "biz-1",
    };
    const result = WhaapyContactUpdatedPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.data.updated_fields).toEqual([]);
    }
  });
});

describe("WhaapyContactDeletedPayloadSchema", () => {
  it("payload con deleted_at presente", () => {
    const payload = {
      data: { contact_id: "c1", deleted_at: "2026-05-22T22:13:17.792Z" },
      event: "contact.deleted",
      businessId: "biz-1",
    };
    const result = WhaapyContactDeletedPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("payload sin deleted_at → tolerado (worker fallback a env.receivedAt)", () => {
    const payload = {
      data: { contact_id: "c1" },
      event: "contact.deleted",
      businessId: "biz-1",
    };
    const result = WhaapyContactDeletedPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });
});

describe("WhaapyConversation*PayloadSchemas", () => {
  // Convención REAL (capturada en prod): `conversation_id`, NO `id`.
  it("conversation.created mínimo (conversation_id + contact_id)", () => {
    const payload = {
      data: { conversation_id: "conv-1", contact_id: "c1", phone_number: "521..." },
      event: "conversation.created",
      businessId: "biz-1",
    };
    const result = WhaapyConversationCreatedPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("conversation.assigned requiere assigned_to; contact_id es opcional (viene solo phone)", () => {
    const valid = {
      data: { conversation_id: "conv-1", assigned_to: "agent-1", phone_number: "521..." },
      event: "conversation.assigned",
      businessId: "biz-1",
    };
    const invalid = {
      data: { conversation_id: "conv-1", phone_number: "521..." },
      event: "conversation.assigned",
      businessId: "biz-1",
    };
    expect(WhaapyConversationAssignedPayloadSchema.safeParse(valid).success).toBe(true);
    expect(WhaapyConversationAssignedPayloadSchema.safeParse(invalid).success).toBe(false);
  });

  it("conversation.unassigned mínimo (conversation_id)", () => {
    const payload = {
      data: { conversation_id: "conv-1", phone_number: "521..." },
      event: "conversation.unassigned",
      businessId: "biz-1",
    };
    const result = WhaapyConversationUnassignedPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("conversation.closed mínimo (conversation_id)", () => {
    const payload = {
      data: { conversation_id: "conv-1", phone_number: "521..." },
      event: "conversation.closed",
      businessId: "biz-1",
    };
    const result = WhaapyConversationClosedPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });
});

describe("WhaapyContactGetResponseSchema (GET /contacts/v1/{id})", () => {
  // Shape derivado de captura real con scripts/whaapy/inspect-get-contact.ts
  // (2026-05-22): el response viene envuelto en `{ contact: {...}, conversations: [...] }`,
  // NO flat. Inner usa snake_case (igual que webhooks). Estos tests
  // reemplazan a los previos basados en doc — esos asumían shape flat
  // y dejaron pasar el bug de DLQ en M4.

  it("response real mínimo — wrapper contact con solo id", () => {
    const response = { contact: { id: "c1" } };
    const result = WhaapyContactGetResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contact.id).toBe("c1");
    }
  });

  it("response real con address omitido (caso del contact recién creado sin dirección)", () => {
    const response = {
      contact: {
        id: "c1",
        name: "X",
        first_name: "X",
        last_name: null,
        phone_number: "525500000000",
        email: null,
        tags: [],
        // sin address
      },
      conversations: [],
    };
    const result = WhaapyContactGetResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });

  it("response real completo — espejo de la captura del 2026-05-22", () => {
    const response = {
      contact: {
        id: "1e9f3641-b882-45c5-a0e7-2c7fad2b47f5",
        phone_number: "525511111111",
        name: "Test Nuevo Editado",
        first_name: "Test",
        last_name: "Nuevo Editado",
        wa_name: null,
        email: null,
        avatar_url: null,
        tags: [],
        custom_fields: { last_platform_write_at: "2026-05-22T22:00:00Z" },
        external_ids: {},
        notes: [],
        funnel_stage: null,
        source: "manual",
        company: null,
        address: null,
        city: null,
        state: null,
        postal_code: null,
        country: "MX",
        assigned_agent_id: null,
        last_contact_at: "2026-05-23T02:32:23.443Z",
        created_at: "2026-05-23T02:02:54.037Z",
        updated_at: "2026-05-23T02:39:52.970Z",
        is_blocked: false,
        blocked_at: null,
      },
      conversations: [],
    };
    const result = WhaapyContactGetResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contact.custom_fields?.last_platform_write_at).toBe(
        "2026-05-22T22:00:00Z",
      );
    }
  });

  it("rechaza shape flat (regresión del bug original)", () => {
    const flat = { id: "c1", name: "X", phone_number: "525500000000" };
    const result = WhaapyContactGetResponseSchema.safeParse(flat);
    expect(result.success).toBe(false);
  });
});

describe("extractBusinessId / extractTopic / extractTimestamp", () => {
  it("extractBusinessId lee del root, ignora data.businessId", () => {
    expect(
      extractBusinessId({ businessId: "root-biz", data: { businessId: "nested-biz" } }),
    ).toBe("root-biz");
    expect(extractBusinessId({ data: { businessId: "nested-only" } })).toBe(null);
    expect(extractBusinessId(null)).toBe(null);
  });

  it("extractTopic acepta `event` o `topic` en root", () => {
    expect(extractTopic({ event: "contact.created" })).toBe("contact.created");
    expect(extractTopic({ topic: "contact.updated" })).toBe("contact.updated");
    expect(extractTopic({})).toBe(null);
  });

  it("extractTimestamp lee del root", () => {
    expect(extractTimestamp({ timestamp: "2026-05-22T22:13:17.792Z" })).toBe(
      "2026-05-22T22:13:17.792Z",
    );
    expect(extractTimestamp({})).toBe(null);
  });
});
