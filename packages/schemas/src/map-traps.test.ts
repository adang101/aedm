import { describe, expect, it } from "vitest";
import { ALTAR_BOONS, INTERACTABLE_KINDS } from "./enums";
import { makeMap } from "./fixtures/map";
import { InteractableObjectSchema, MapSchema, PublicInteractableObjectSchema } from "./map";
import { ActPayload, ClientMessageSchema, ServerMessageSchema, WS_VERSION } from "./ws";

const withObjects = (extra: unknown[]) => {
  const m = makeMap();
  (m.layers[4] as { objects: unknown[] }).objects.push(...extra);
  return m;
};
const ok = (extra: unknown[]) => MapSchema.safeParse(withObjects(extra)).success;
const trap = { type: "interactable", id: "trap_1", kind: "trap", state: "closed", x: 6, y: 6, trap: { dc: 12, dice: "2d6", damage_type: "sharp" } };
const env = (type: string, payload: unknown) => ({ v: WS_VERSION, type, id: "c1", ts: 1700000000000, payload });

describe("traps, hidden objects and altars in the Map", () => {
  it("has the trap kind and a short list of altar boons", () => {
    expect(INTERACTABLE_KINDS).toContain("trap");
    expect([...ALTAR_BOONS]).toEqual(["mend", "ward", "cleanse"]);
  });
  it("a trap carries a DC of 5 to 30, dice and a damage type, and may be hidden", () => {
    expect(ok([trap])).toBe(true);
    expect(ok([{ ...trap, hidden: true }])).toBe(true);
    expect(ok([{ ...trap, trap: { ...trap.trap, dc: 4 } }])).toBe(false);
    expect(ok([{ ...trap, trap: { ...trap.trap, dc: 31 } }])).toBe(false);
    expect(ok([{ ...trap, trap: { ...trap.trap, dice: "lots" } }])).toBe(false);
    expect(ok([{ ...trap, trap: { ...trap.trap, damage_type: "love" } }])).toBe(false);
    expect(ok([{ ...trap, trap: { dc: 12, dice: "2d6" } }])).toBe(false);
  });
  it("only a trap or a chest can be hidden, and only a trap has trap details", () => {
    expect(ok([{ type: "interactable", id: "chest_9", kind: "chest", state: "closed", hidden: true, x: 8, y: 8 }])).toBe(true);
    expect(ok([{ type: "interactable", id: "lever_9", kind: "lever", state: "closed", hidden: true, x: 8, y: 8 }])).toBe(false);
    expect(ok([{ type: "interactable", id: "door_9", kind: "door", state: "closed", hidden: true, x: 8, y: 8 }])).toBe(false);
    expect(ok([{ type: "interactable", id: "chest_9", kind: "chest", state: "closed", trap: trap.trap, x: 8, y: 8 }])).toBe(false);
  });
  it("an altar may name a boon, from the list only; no other kind may", () => {
    const altar = { type: "interactable", id: "altar_1", kind: "altar", state: "closed", x: 8, y: 8 };
    expect(ok([altar])).toBe(true);
    for (const boon of ALTAR_BOONS) expect(ok([{ ...altar, altar: { boon } }]), boon).toBe(true);
    expect(ok([{ ...altar, altar: { boon: "doom" } }])).toBe(false);
    expect(ok([{ ...altar, altar: {} }])).toBe(false);
    expect(ok([{ ...altar, kind: "sign", id: "sign_9", altar: { boon: "mend" } }])).toBe(false);
  });
  it("the public shape never has hidden, trap or altar", () => {
    expect(PublicInteractableObjectSchema.safeParse({ type: "interactable", id: "trap_1", kind: "trap", state: "closed", x: 1, y: 1 }).success).toBe(true);
    expect(PublicInteractableObjectSchema.safeParse({ ...trap, hidden: true }).success).toBe(false);
    expect(PublicInteractableObjectSchema.safeParse(trap).success).toBe(false);
    expect(InteractableObjectSchema.safeParse(trap).success).toBe(true);
  });
});

describe("act: search and disarm", () => {
  it("search takes no target; every other verb needs one", () => {
    expect(ActPayload.safeParse({ verb: "search" }).success).toBe(true);
    expect(ActPayload.safeParse({ verb: "search", target_id: "trap_1" }).success).toBe(false);
    expect(ActPayload.safeParse({ verb: "disarm", target_id: "trap_1" }).success).toBe(true);
    expect(ActPayload.safeParse({ verb: "disarm" }).success).toBe(false);
    expect(ActPayload.safeParse({ verb: "open" }).success).toBe(false);
    expect(ClientMessageSchema.safeParse(env("act", { verb: "search" })).success).toBe(true);
    expect(ClientMessageSchema.safeParse(env("act", { verb: "interact", target_id: "altar_1" })).success).toBe(true);
  });
});

describe("state_diff: interactables_revealed", () => {
  const object = { type: "interactable", id: "trap_1", kind: "trap", state: "closed", x: 6, y: 6 };
  const diff = { seq: 3, changed: [], removed: [], interactables_revealed: [{ map_id: "m_lighthouse", object }] };
  it("carries public objects only", () => {
    expect(ServerMessageSchema.safeParse(env("state_diff", diff)).success).toBe(true);
    expect(ServerMessageSchema.safeParse(env("state_diff", { ...diff, interactables_revealed: [{ map_id: "m_lighthouse", object: trap }] })).success).toBe(false);
    expect(ServerMessageSchema.safeParse(env("state_diff", { ...diff, interactables_revealed: [{ map_id: "m_lighthouse", object: { ...object, hidden: true } }] })).success).toBe(false);
    expect(ServerMessageSchema.safeParse(env("state_diff", { ...diff, interactables_revealed: Array(101).fill(diff.interactables_revealed[0]) })).success).toBe(false);
    expect(ServerMessageSchema.safeParse(env("state_diff", { seq: 5, changed: [], removed: [] })).success).toBe(true);
  });
});
