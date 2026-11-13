import { describe, expect, it } from "vitest";
import { makeMap } from "./fixtures/map";
import { MapSchema } from "./map";

describe("Map interactables: lock, links, text", () => {
  const withObjects = (extra: unknown[]) => {
    const m = makeMap();
    (m.layers[4] as { objects: unknown[] }).objects.push(...extra);
    return m;
  };
  const ok = (extra: unknown[]) => MapSchema.safeParse(withObjects(extra)).success;
  const door = { type: "interactable", id: "door_1", kind: "door", state: "locked", x: 6, y: 6 };
  const lever = { type: "interactable", id: "lever_1", kind: "lever", state: "closed", x: 7, y: 7 };

  it("a v2 map without the new fields still parses (they are additive)", () => {
    expect(MapSchema.safeParse(makeMap()).success).toBe(true);
    expect(ok([door])).toBe(true);
  });
  it("chests and doors take a lock with a DC of 5 to 30 and an optional key name", () => {
    expect(ok([{ ...door, lock: { dc: 15 } }])).toBe(true);
    expect(ok([{ ...door, lock: { dc: 15, key_item_name: "Brass key" } }])).toBe(true);
    expect(ok([{ ...door, lock: { dc: 4 } }])).toBe(false);
    expect(ok([{ ...door, lock: { dc: 31 } }])).toBe(false);
    expect(ok([{ ...door, lock: { dc: 15, picks: 3 } }])).toBe(false);
    expect(ok([{ type: "interactable", id: "sign_1", kind: "sign", state: "closed", lock: { dc: 10 }, x: 7, y: 7 }])).toBe(false);
  });
  it("a lever links to doors on the same map, 1 to 4 of them", () => {
    expect(ok([door, { ...lever, links: ["door_1"] }])).toBe(true);
    expect(ok([{ ...lever, links: ["door_1"] }])).toBe(false); // no such door
    expect(ok([door, { ...lever, links: ["desk"] }])).toBe(false); // a chest is not a door
    expect(ok([door, { ...lever, links: [] }])).toBe(false);
    expect(ok([door, { ...door, id: "door_2", x: 9, y: 9 }, { ...lever, links: ["door_1", "door_2"] }])).toBe(true);
    expect(ok([door, { ...door, kind: "chest", id: "chest_9", x: 9, y: 9, links: ["door_1"] }])).toBe(false);
  });
  it("a sign carries text of at most 200 characters", () => {
    const sign = { type: "interactable", id: "sign_1", kind: "sign", state: "closed", x: 7, y: 7 };
    expect(ok([{ ...sign, text: "Mind the step." }])).toBe(true);
    expect(ok([{ ...sign, text: "x".repeat(200) }])).toBe(true);
    expect(ok([{ ...sign, text: "x".repeat(201) }])).toBe(false);
    expect(ok([{ ...sign, text: "" }])).toBe(false);
    expect(ok([{ ...sign, kind: "altar", text: "Hello" }])).toBe(false);
  });
});
