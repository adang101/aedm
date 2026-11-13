import { describe, expect, it } from "vitest";
import { classifyIntent, type IntentContext } from "./intents.ts";

const ctx: IntentContext = {
  actorId: "pc_1",
  objects: [{ id: "obj_chest", kind: "chest" }, { id: "obj_door", kind: "door" }, { id: "obj_lever", kind: "lever" }],
  exits: [{ name: "Lighthouse door" }, { name: "South road" }],
  entities: [
    { id: "pc_1", name: "Mara", kind: "pc" },
    { id: "pc_2", name: "Tov", kind: "pc" },
    { id: "npc_1", name: "Odalys Brand", kind: "npc" },
    { id: "en_1", name: "Marsh Brute", kind: "enemy" },
  ],
};

const kind = (t: string, c: IntentContext = ctx) => classifyIntent(t, c).kind;

describe("classifyIntent: mechanical", () => {
  it("treats empty and whitespace-only input as mechanical", () => {
    expect(classifyIntent("", ctx)).toEqual({ kind: "mechanical", action: "empty" });
    expect(classifyIntent("  \n\t ", ctx)).toEqual({ kind: "mechanical", action: "empty" });
  });

  it("recognizes /ooc", () => {
    expect(classifyIntent("/ooc brb two minutes", ctx)).toEqual({ kind: "mechanical", action: "ooc", text: "brb two minutes" });
    expect(classifyIntent("/OOC hi", ctx)).toMatchObject({ action: "ooc" });
  });

  it("recognizes compass walks", () => {
    expect(classifyIntent("I walk north", ctx)).toEqual({ kind: "mechanical", action: "move_dir", direction: "n" });
    expect(classifyIntent("go south.", ctx)).toMatchObject({ action: "move_dir", direction: "s" });
    expect(classifyIntent("Head east!", ctx)).toMatchObject({ action: "move_dir", direction: "e" });
    expect(classifyIntent("we move west", ctx)).toMatchObject({ action: "move_dir", direction: "w" });
    expect(classifyIntent("go to the north", ctx)).toMatchObject({ action: "move_dir", direction: "n" });
  });

  it("recognizes walking to a uniquely named object kind, exit or non-hostile entity", () => {
    expect(classifyIntent("go to the door", ctx)).toEqual({ kind: "mechanical", action: "move_to", target: { type: "object", id: "obj_door" }, label: "the door" });
    expect(classifyIntent("walk to the chest", ctx)).toMatchObject({ target: { type: "object", id: "obj_chest" } });
    expect(classifyIntent("I head toward the Lighthouse door", ctx)).toMatchObject({ target: { type: "exit", id: "Lighthouse door" } });
    expect(classifyIntent("go to Odalys Brand", ctx)).toMatchObject({ target: { type: "entity", id: "npc_1" } });
    expect(classifyIntent("walk up to the lever.", ctx)).toMatchObject({ target: { type: "object", id: "obj_lever" } });
  });
});

describe("classifyIntent: narrative (conservative)", () => {
  it.each([
    "open the chest",
    "pick up the key",
    "I open the chest carefully while watching the priest",
    "go to the door and listen",
    "walk north then hide behind the barrel",
    "walk north quietly",
    "go to the door, slowly",
    "I sneak to the door",
    "go to the altar",
    "go to the marsh brute",
    "attack the brute",
    "ask Odalys about the lighthouse",
    "go to the north door",
    "walk to yourself",
    "hello there",
    "n",
    "run away screaming",
  ])("%s", (t) => {
    expect(kind(t)).toBe("narrative");
  });

  it("an ambiguous target (two matches) is narrative", () => {
    const two: IntentContext = { ...ctx, objects: [{ id: "a", kind: "chest" }, { id: "b", kind: "chest" }] };
    expect(kind("go to the chest", two)).toBe("narrative");
    const clash: IntentContext = { ...ctx, entities: [...ctx.entities, { id: "npc_2", name: "Odalys Brand", kind: "npc" }] };
    expect(kind("go to Odalys Brand", clash)).toBe("narrative");
  });

  it("the actor is not a valid target for themselves", () => {
    expect(kind("go to Mara")).toBe("narrative");
    expect(classifyIntent("go to Tov", ctx)).toMatchObject({ kind: "mechanical", target: { id: "pc_2" } });
  });

  it("a name that matches across categories is narrative", () => {
    const c: IntentContext = { ...ctx, exits: [{ name: "door" }] };
    expect(kind("go to the door", c)).toBe("narrative");
  });
});
