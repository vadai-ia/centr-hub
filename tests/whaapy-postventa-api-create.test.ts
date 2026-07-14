import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * createPostventaContact — parseo del id (respuesta envuelta `{contact:{id}}`
 * o plana `{id}`) e idempotencia por 409 `duplicate_contact` →
 * `existing_contact_id`.
 */

vi.mock("@/lib/whaapy-postventa/client", () => ({
  whaapyPostventaRestWith409: vi.fn(),
}));

import { createPostventaContact } from "@/lib/whaapy-postventa/api";
import { whaapyPostventaRestWith409 } from "@/lib/whaapy-postventa/client";

const mock = mock409();
function mock409() {
  return whaapyPostventaRestWith409 as unknown as ReturnType<typeof vi.fn>;
}

const ORG = "org-1";
const input = {
  name: "Cliente",
  phoneE164: "+525512345678",
  email: "c@test.mx",
  customFields: { centrhub_opportunity_id: "opp-1" },
};

beforeEach(() => vi.clearAllMocks());

describe("createPostventaContact", () => {
  it("respuesta envuelta {contact:{id}} → devuelve el id", async () => {
    mock.mockResolvedValue({ ok: true, data: { contact: { id: "wc-1" } } });
    await expect(createPostventaContact(ORG, input)).resolves.toBe("wc-1");
  });

  it("respuesta plana {id} → devuelve el id (fallback)", async () => {
    mock.mockResolvedValue({ ok: true, data: { id: "wc-2" } });
    await expect(createPostventaContact(ORG, input)).resolves.toBe("wc-2");
  });

  it("409 duplicate_contact → enlaza existing_contact_id (idempotente)", async () => {
    mock.mockResolvedValue({
      ok: false,
      status: 409,
      body: { error: "duplicate_contact", existing_contact_id: "wc-existing" },
    });
    await expect(createPostventaContact(ORG, input)).resolves.toBe("wc-existing");
  });

  it("omite name/email vacíos pero siempre manda phone + custom_fields", async () => {
    mock.mockResolvedValue({ ok: true, data: { contact: { id: "wc-3" } } });
    await createPostventaContact(ORG, { ...input, name: null, email: null });
    const body = mock.mock.calls[0][3] as Record<string, unknown>;
    expect(body).toMatchObject({
      phone_number: "+525512345678",
      custom_fields: { centrhub_opportunity_id: "opp-1" },
    });
    expect(body).not.toHaveProperty("name");
    expect(body).not.toHaveProperty("email");
  });
});
