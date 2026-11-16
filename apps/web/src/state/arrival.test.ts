import type { ServerMessage } from "@aedm/schemas";
import { describe, expect, it } from "vitest";
import { buildScenes } from "../net/mock-world";
import { arrivalLine, isRawArrivalLine, placeName } from "./arrival";
import { applyServerMessage, createInitialState } from "./store";

const scenes = buildScenes();
let n = 0;
const msg = <T extends ServerMessage["type"]>(type: T, payload: Extract<ServerMessage, { type: T }>["payload"]) =>
  ({ v: 1, type, id: `s${++n}`, ts: 0, payload }) as unknown as ServerMessage;
const snap = (id: string) => msg("state_snapshot", { seq: ++n, mode: "exploration", entities: [], party: [], quests: [], map: scenes[id]!.map });

describe("arrival", () => {
  it("names the place from the map's setting", () => {
    expect(placeName(scenes.m_crypt!.map)).toBe("Drowned Crypt");
    expect(arrivalLine(scenes.m_crypt!.map)).toBe("The party arrives at Drowned Crypt.");
    expect(placeName({ meta: undefined } as never)).toBe("An unnamed place");
  });

  it("recognises the engine's id-only arrival line", () => {
    expect(isRawArrivalLine("The party arrives at m_gen_3 (party_start)")).toBe(true);
    expect(isRawArrivalLine("The party arrives at the Drowned Crypt.")).toBe(false);
    expect(isRawArrivalLine("Odalys arrives at m_x (door)")).toBe(false);
  });

  it("logs one named line per scene change, none for the first map or a repeat snapshot", () => {
    const s = createInitialState();
    applyServerMessage(s, snap("m_hollowmere"), 0);
    expect(s.log).toHaveLength(0);
    applyServerMessage(s, snap("m_hollowmere"), 0);
    expect(s.log).toHaveLength(0);
    applyServerMessage(s, msg("log", { kind: "engine", text: "The party arrives at m_crypt (party_start)" }), 0);
    applyServerMessage(s, snap("m_crypt"), 0);
    expect(s.log.map((l) => l.text)).toEqual(["The party arrives at Drowned Crypt."]);
    expect(s.log[0]!.kind).toBe("system");
  });
});
