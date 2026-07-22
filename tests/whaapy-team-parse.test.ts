import { describe, expect, it } from "vitest";
import { parseWhaapyTeamResponse } from "@/lib/whaapy/team";

/**
 * `parseWhaapyTeamResponse` es TOLERANTE porque la forma real de `/team/v1` no
 * está confirmada contra captura (ver lib/whaapy/team.ts + whaapy:inspect-team).
 * Estos tests fijan las formas que debe aceptar; si la real difiere, endurecer.
 */

describe("parseWhaapyTeamResponse", () => {
  it("acepta un array plano", () => {
    const r = parseWhaapyTeamResponse([
      { id: "a1", name: "Gina", email: "gina@x.com" },
      { id: "a2", name: "Pepe", email: null },
    ]);
    expect(r).toEqual([
      { id: "a1", name: "Gina", email: "gina@x.com" },
      { id: "a2", name: "Pepe", email: null },
    ]);
  });

  it("acepta envoltorios comunes: {team}, {agents}, {data}", () => {
    expect(parseWhaapyTeamResponse({ team: [{ id: "t1", name: "T" }] })).toHaveLength(1);
    expect(parseWhaapyTeamResponse({ agents: [{ id: "g1" }] })[0].id).toBe("g1");
    expect(parseWhaapyTeamResponse({ data: [{ id: "d1" }] })[0].id).toBe("d1");
  });

  it("acepta anidación {data:{team:[...]}}", () => {
    const r = parseWhaapyTeamResponse({ data: { team: [{ id: "n1", full_name: "N" }] } });
    expect(r).toEqual([{ id: "n1", name: "N", email: null }]);
  });

  it("resuelve alias de campos (agent_id, full_name, email_address)", () => {
    const r = parseWhaapyTeamResponse([
      { agent_id: "x1", full_name: "Equis", email_address: "x@x.com" },
    ]);
    expect(r).toEqual([{ id: "x1", name: "Equis", email: "x@x.com" }]);
  });

  it("descarta items sin id y deduplica por id", () => {
    const r = parseWhaapyTeamResponse([
      { name: "sin id" },
      { id: "dup", name: "primero" },
      { id: "dup", name: "segundo" },
    ]);
    expect(r).toEqual([{ id: "dup", name: "primero", email: null }]);
  });

  it("devuelve [] para entradas no reconocibles", () => {
    expect(parseWhaapyTeamResponse(null)).toEqual([]);
    expect(parseWhaapyTeamResponse("texto")).toEqual([]);
    expect(parseWhaapyTeamResponse({ nope: 1 })).toEqual([]);
    expect(parseWhaapyTeamResponse({ team: "no-array" })).toEqual([]);
  });
});
