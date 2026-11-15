import { describe, expect, it } from "vitest";
import { classifyIntent, type IntentContext } from "./intents.ts";

const base: IntentContext = {
  actorId: "pc_1",
  objects: [{ id: "door_1", kind: "door", dist: 1 }],
  exits: [],
  entities: [{ id: "pc_1", name: "Mara Venn", kind: "pc" }, { id: "npc_1", name: "Odalys Brand", kind: "npc" }],
  inventory: [{ id: "it_9", name: "Iron lantern" }, { id: "it_10", name: "Healing draught" }],
};
const withObjects = (...objects: IntentContext["objects"]): IntentContext => ({ ...base, objects: [...base.objects, ...objects] });
const NARRATIVE = { kind: "narrative" };

describe("intents: search", () => {
  it.each([
    "search", "Search.", "search the room", "search the area", "search here", "search around", "search around here", "I search the room",
    "search for traps", "search for secrets", "look for traps", "check for traps", "let's search for traps", "search for any traps",
  ])("%s is a search", (text) => {
    expect(classifyIntent(text, base)).toEqual({ kind: "mechanical", action: "search" });
  });
  it.each([
    "search the chest", "search carefully", "search the room for the key", "search for the missing key", "search the body", "look for Edda",
    "check for signs of life", "search, then open the door", "search for traps while Tov watches", "searching",
  ])("%s stays narrative", (text) => {
    expect(classifyIntent(text, base)).toEqual(NARRATIVE);
  });
  it("look around is still a look", () => {
    expect(classifyIntent("look around", base)).toEqual({ kind: "mechanical", action: "look" });
  });
});

describe("intents: disarm", () => {
  const armed = { id: "trap_1", kind: "trap", dist: 1, state: "closed" };
  it("disarm the trap is an act when exactly one revealed armed trap is in the scene", () => {
    const want = { kind: "mechanical", action: "act", verb: "disarm", targetId: "trap_1", label: "the trap" };
    expect(classifyIntent("disarm the trap", withObjects(armed))).toEqual(want);
    expect(classifyIntent("Disarm trap.", withObjects(armed))).toEqual(want);
    expect(classifyIntent("I'll defuse the trap", withObjects(armed))).toEqual(want);
    expect(classifyIntent("disarm trap_1", withObjects(armed))).toEqual(want);
    expect(classifyIntent("disarm the trap", withObjects({ id: "trap_1", kind: "trap", dist: 1 }))).toEqual(want); // no state: armed
    // a sprung one beside it does not count
    expect(classifyIntent("disarm the trap", withObjects(armed, { id: "trap_2", kind: "trap", dist: 2, state: "open" }))).toEqual(want);
  });
  it("is narrative with no trap, a sprung trap only, two armed traps, or anything extra", () => {
    expect(classifyIntent("disarm the trap", base)).toEqual(NARRATIVE);
    expect(classifyIntent("disarm the trap", withObjects({ id: "trap_1", kind: "trap", state: "open" }))).toEqual(NARRATIVE);
    expect(classifyIntent("disarm the trap", withObjects(armed, { id: "trap_2", kind: "trap", state: "closed" }))).toEqual(NARRATIVE);
    expect(classifyIntent("disarm trap_2", withObjects(armed, { id: "trap_2", kind: "trap", state: "closed" }))).toEqual({
      kind: "mechanical", action: "act", verb: "disarm", targetId: "trap_2", label: "the trap",
    });
    expect(classifyIntent("disarm the trap carefully", withObjects(armed))).toEqual(NARRATIVE);
    expect(classifyIntent("disarm the door", withObjects(armed))).toEqual(NARRATIVE);
    expect(classifyIntent("disarm the trap, then walk away", withObjects(armed))).toEqual(NARRATIVE);
  });
  it("a trap can be examined by kind", () => {
    expect(classifyIntent("examine the trap", withObjects(armed))).toEqual({ kind: "mechanical", action: "act", verb: "examine", targetId: "trap_1", label: "the trap" });
  });
});

describe("intents: altar", () => {
  const altar = { id: "altar_1", kind: "altar", dist: 1 };
  const want = { kind: "mechanical", action: "act", verb: "interact", targetId: "altar_1", label: "the altar" };
  it("pray at, touch or use the altar is an interact when exactly one altar is in the scene", () => {
    for (const t of ["pray at the altar", "pray to the altar", "touch the altar", "use the altar", "Use altar.", "kneel at the altar", "I touch the altar"]) {
      expect(classifyIntent(t, withObjects(altar)), t).toEqual(want);
    }
  });
  it("is narrative with no altar, two altars, or extra words", () => {
    expect(classifyIntent("pray at the altar", base)).toEqual(NARRATIVE);
    expect(classifyIntent("touch the altar", withObjects(altar, { id: "altar_2", kind: "altar", dist: 5 }))).toEqual(NARRATIVE);
    expect(classifyIntent("pray at the altar for guidance", withObjects(altar))).toEqual(NARRATIVE);
    expect(classifyIntent("touch the altar gently", withObjects(altar))).toEqual(NARRATIVE);
    expect(classifyIntent("touch the statue", withObjects(altar))).toEqual(NARRATIVE);
  });
  it("does not disturb using a carried item", () => {
    expect(classifyIntent("use the healing draught", withObjects(altar))).toEqual({ kind: "mechanical", action: "use_item", itemId: "it_10", label: "Healing draught" });
    expect(classifyIntent("use the iron lantern", withObjects(altar))).toMatchObject({ action: "use_item", itemId: "it_9" });
    expect(classifyIntent("use the rope", withObjects(altar))).toEqual(NARRATIVE);
  });
});
