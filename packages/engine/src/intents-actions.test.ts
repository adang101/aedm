import { describe, expect, it } from "vitest";
import { classifyIntent, type IntentContext } from "./intents.ts";

// Looking, the pack, waiting, using items, attacks, examining creatures and more ways to walk.

const wide: IntentContext = {
  actorId: "pc_1",
  objects: [{ id: "door_1", kind: "door", dist: 3 }, { id: "lever_1", kind: "lever", dist: 3 }],
  exits: [{ name: "North gate", side: "n" }, { name: "Cellar stairs", side: "s" }],
  entities: [
    { id: "pc_1", name: "Mara Venn", kind: "pc" },
    { id: "pc_2", name: "Tov Rask", kind: "pc" },
    { id: "pc_3", name: "Tov Lin", kind: "pc" },
    { id: "pc_4", name: "Edda Marrow", kind: "pc" },
    { id: "npc_1", name: "Odalys Brand", kind: "npc" },
    { id: "npc_2", name: "Merchant", kind: "npc" },
    { id: "en_1", name: "Marsh Brute", kind: "enemy" },
    { id: "en_2", name: "Bog Rat", kind: "enemy" },
    { id: "en_3", name: "Bog Rat", kind: "enemy" },
    { id: "en_4", name: "Merchant", kind: "enemy" },
    { id: "en_5", name: "Cultist", kind: "enemy" },
  ],
  inventory: [
    { id: "it_1", name: "Healing draught" }, { id: "it_2", name: "Iron lantern", usable: false }, { id: "it_3", name: "Brass key", usable: false },
  ],
};
const w = (t: string, over: Partial<IntentContext> = {}) => classifyIntent(t, { ...wide, ...over });

describe("classifyIntent: look, inventory, wait", () => {
  it.each(["look", "look around", "I look around", "survey the room", "what do I see", "what do i see?", "take a look around", "we look around."])("look: %s", (t) => {
    expect(w(t)).toEqual({ kind: "mechanical", action: "look" });
  });
  it.each(["inventory", "check my pack", "Check my bag.", "what am I carrying", "what am I carrying?", "I check my inventory", "what do I have"])("inventory: %s", (t) => {
    expect(w(t)).toEqual({ kind: "mechanical", action: "inventory" });
  });
  it.each(["wait", "I wait", "do nothing", "pass", "I pass.", "wait here"])("wait: %s", (t) => {
    expect(w(t)).toEqual({ kind: "mechanical", action: "wait" });
  });
  it.each([
    "look at the stars", "look around carefully", "look around for traps", "I look around the room and listen", "look behind the door",
    "look around, then open the door", "what do I see in the shadows?", "what do you see", "survey the room for exits and ambushes",
    "check my pack for a rope and tie it to the lever", "check my bag quietly", "what am I carrying that could help?", "inventory of the chest",
    "wait for the guard to leave", "wait until dark", "I wait and listen", "wait, what was that?", "pass the salt", "do nothing and watch",
  ])("stays narrative: %s", (t) => {
    expect(w(t).kind).toBe("narrative");
  });
});

describe("classifyIntent: use_item", () => {
  it("uses a carried, usable item on yourself or a uniquely named party member", () => {
    expect(w("drink the healing draught")).toEqual({ kind: "mechanical", action: "use_item", itemId: "it_1", label: "Healing draught" });
    expect(w("quaff my healing draught")).toMatchObject({ action: "use_item", itemId: "it_1" });
    expect(w("I use a healing draught.")).toMatchObject({ action: "use_item", itemId: "it_1" });
    expect(w("use the healing draught on Edda Marrow")).toEqual({ kind: "mechanical", action: "use_item", itemId: "it_1", targetId: "pc_4", label: "Healing draught on Edda Marrow" });
    expect(w("use the healing draught on edda")).toMatchObject({ targetId: "pc_4" });
  });
  it("stays narrative for anything the engine could not use or resolve", () => {
    for (const t of [
      "use the lever", "use the iron lantern", "use the brass key on the door", "drink the ale", "use the healing draught on Tov",
      "use the healing draught on Odalys Brand", "use the healing draught on the Marsh Brute", "drink the healing draught slowly",
      "drink the healing draught and run", "use the healing draught on Edda Marrow, quickly", "drink the healing draught?", "use my healing draught on the door",
    ]) expect(w(t).kind, t).toBe("narrative");
    expect(w("drink the healing draught", { inventory: [] }).kind).toBe("narrative");
  });
  it("using it on yourself needs no target id", () => {
    expect(w("use the healing draught on Mara Venn")).toEqual({ kind: "mechanical", action: "use_item", itemId: "it_1", label: "Healing draught" });
  });
});

describe("classifyIntent: attack", () => {
  it("attacks a uniquely named enemy", () => {
    expect(w("attack the marsh brute")).toEqual({ kind: "mechanical", action: "attack", targetId: "en_1", label: "Marsh Brute" });
    expect(w("I fight the cultist")).toMatchObject({ action: "attack", targetId: "en_5" });
    expect(w("charge at the cultist.")).toMatchObject({ action: "attack", targetId: "en_5" });
    for (const v of ["strike", "hit", "shoot", "charge", "attack at"]) expect(w(`${v} the marsh brute`), v).toMatchObject({ action: "attack", targetId: "en_1" });
  });
  it("never attacks an NPC, a party member, an ambiguous name or an unknown one", () => {
    for (const t of [
      "attack the merchant", // an NPC and an enemy share the name
      "attack Odalys Brand", "attack Tov Rask", "attack Mara Venn", "attack the bog rat", "attack the dragon", "attack",
      "attack the cultist with my sword", "attack the cultist from behind", "attack the cultist, then run", "attack the cultist and the brute", "hit the cultist hard",
      "attack the door", "fight!", "attack the cultist?",
    ]) expect(w(t).kind, t).toBe("narrative");
    expect(w("attack the merchant", { entities: wide.entities.filter((e) => e.id !== "en_4") }).kind).toBe("narrative"); // only an NPC
  });
});

describe("classifyIntent: examining creatures", () => {
  it("lets the examine verbs name a uniquely named creature", () => {
    expect(w("examine the marsh brute")).toEqual({ kind: "mechanical", action: "act", verb: "examine", targetId: "en_1", label: "Marsh Brute" });
    expect(w("look at Odalys Brand")).toMatchObject({ verb: "examine", targetId: "npc_1" });
    expect(w("inspect edda marrow")).toMatchObject({ verb: "examine", targetId: "pc_4" });
    expect(w("I look at the cultist.")).toMatchObject({ verb: "examine", targetId: "en_5" });
  });
  it("objects still win when only they match, and ambiguity stays narrative", () => {
    expect(w("examine the door")).toMatchObject({ targetId: "door_1" });
    for (const t of ["examine the bog rat", "look at the merchant", "look at Tov Rask suspiciously", "examine Mara Venn", "look at the stars", "examine the marsh brute for weaknesses", "look at the brute's weapon"]) {
      expect(w(t).kind, t).toBe("narrative");
    }
    const both: IntentContext = { ...wide, entities: [...wide.entities, { id: "npc_9", name: "Door", kind: "npc" }] };
    expect(classifyIntent("examine the door", both).kind).toBe("narrative");
  });
});

describe("classifyIntent: more ways to walk", () => {
  it("goes through a uniquely named door or exit", () => {
    expect(w("go through the north gate")).toMatchObject({ action: "move_to", target: { type: "exit", id: "North gate" } });
    expect(w("leave through the north gate")).toMatchObject({ action: "move_to", target: { type: "exit", id: "North gate" } });
    expect(w("enter the cellar stairs")).toMatchObject({ action: "move_to", target: { type: "exit", id: "Cellar stairs" } });
    expect(w("go through the door")).toMatchObject({ action: "move_to", target: { type: "object", id: "door_1" } });
  });
  it("takes the exit on a side", () => {
    expect(w("take the north exit")).toMatchObject({ action: "move_to", target: { type: "exit", id: "North gate" } });
    expect(w("use the south exit")).toMatchObject({ action: "move_to", target: { type: "exit", id: "Cellar stairs" } });
    expect(w("head north")).toEqual({ kind: "mechanical", action: "move_dir", direction: "n" });
  });
  it("stays narrative when it is not one unique place", () => {
    for (const t of [
      "take the east exit", "go through the window", "leave through the north gate quietly", "go through the north gate and close it behind me",
      "take the north exit, then wait", "enter the cave", "go through the door?",
    ]) expect(w(t).kind, t).toBe("narrative");
    expect(w("take the exit").kind).toBe("narrative"); // two exits
    expect(w("take the exit", { exits: [{ name: "Gate" }] })).toMatchObject({ action: "move_to", target: { type: "exit", id: "Gate" } });
    const two: IntentContext["objects"] = [{ id: "d1", kind: "door" }, { id: "d2", kind: "door" }];
    expect(w("go through the door", { objects: two }).kind).toBe("narrative");
    expect(w("take the north exit", { exits: [{ name: "A", side: "n" }, { name: "B", side: "n" }] }).kind).toBe("narrative");
  });
});
