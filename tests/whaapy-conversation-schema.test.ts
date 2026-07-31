import { describe, it, expect } from "vitest";
import {
  WhaapyConversationCreatedPayloadSchema,
  WhaapyConversationAssignedPayloadSchema,
} from "@/lib/whaapy/mappers";

/**
 * Guard de los schemas conversation.* contra los payloads REALES capturados en
 * producción (ERRORES.md "conversation.* usa conversation_id, no id"). Los
 * schemas viejos exigían `data.id`/`data.contact_id` → toda conversation.*
 * fallaba Zod → DLQ → los leads orgánicos nunca llegaban. Este test replica los
 * bodies exactos que Whaapy envía; si alguien vuelve a asumir `data.id`, falla.
 */

// Payload REAL de conversation.created (MHFP, 2026-07-26).
const CREATED_REAL = {
  event: "conversation.created",
  timestamp: "2026-07-26T22:21:26.033Z",
  businessId: "1db0bff4-e554-4a07-9585-faaf93b401f4",
  data: {
    timestamp: "2026-07-26T22:21:25.986Z",
    contact_id: "3d934282-94c1-45db-b951-dd17b7c8fee8",
    contact_name: "MHFP",
    phone_number: "525525632336",
    conversation_id: "c646d1e7-81f6-4458-a26e-d994c56147af",
    contact_last_name: null,
    contact_first_name: "MHFP",
  },
};

// Payload REAL de conversation.assigned (Daniel Ronzón, 2026-07-16) — SIN contact_id.
const ASSIGNED_REAL = {
  event: "conversation.assigned",
  timestamp: "2026-07-16T21:56:52.500Z",
  businessId: "1db0bff4-e554-4a07-9585-faaf93b401f4",
  data: {
    method: "manual",
    timestamp: "2026-07-16T21:56:52.466Z",
    assigned_by: "3ea36653-9cce-40ff-8331-e59eeefae6bf",
    assigned_to: "19df4c22-c49b-4491-a6fa-13fa0e1205e4",
    contact_name: "Daniel Ronzón",
    phone_number: "522299285456",
    conversation_id: "1996338e-9e84-4caf-89d9-566174ef7923",
  },
};

describe("conversation.* schemas vs payloads reales", () => {
  it("conversation.created REAL parsea (conversation_id, contact_id, phone_number)", () => {
    const p = WhaapyConversationCreatedPayloadSchema.parse(CREATED_REAL);
    expect(p.data.conversation_id).toBe("c646d1e7-81f6-4458-a26e-d994c56147af");
    expect(p.data.contact_id).toBe("3d934282-94c1-45db-b951-dd17b7c8fee8");
    expect(p.data.phone_number).toBe("525525632336");
    expect(p.data.contact_name).toBe("MHFP");
  });

  it("conversation.assigned REAL parsea SIN contact_id (solo phone_number + assigned_to)", () => {
    const p = WhaapyConversationAssignedPayloadSchema.parse(ASSIGNED_REAL);
    expect(p.data.conversation_id).toBe("1996338e-9e84-4caf-89d9-566174ef7923");
    expect(p.data.assigned_to).toBe("19df4c22-c49b-4491-a6fa-13fa0e1205e4");
    expect(p.data.phone_number).toBe("522299285456");
    expect("contact_id" in p.data ? p.data.contact_id : undefined).toBeUndefined();
  });

  it("un payload con el campo viejo `id` (sin conversation_id) YA NO parsea", () => {
    const legacy = { businessId: "x", data: { id: "conv-1", contact_id: "c-1" } };
    expect(WhaapyConversationCreatedPayloadSchema.safeParse(legacy).success).toBe(false);
  });
});
