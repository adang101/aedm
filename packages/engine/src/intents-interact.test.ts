import { describe, expect, it } from "vitest";
import { classifyIntent, type IntentContext } from "./intents.ts";

const ctx: IntentContext = {
  actorId: "pc_1",
  objects: [
    { id: "door_1", kind: "door", dist: 1 },
    { id: "lever_1", kind: "lever", dist: 1 },
    { id: "sign_1", kind: "sign", dist: 3 },
    { id: "altar_1", kind: "altar", dist: 1 },
    { id: "chest_1", kind: "chest", dist: 1 },
  ],
  exits: [],
  entities: [
    { id: "pc_1", name: "Mara Venn", kind: "pc" },
    { id: "pc_2", name: "Tov Rask", kind: "pc" },
    { id: "pc_3", name: "Tov Lin", kind: "pc" },
    { id: "pc_4", name: "Edda Marrow", kind: "pc" },
    { id: "npc_1", name: "Odalys Brand", kind: "npc" },
  ],
  containers: [
    { id: "cn_1", kind: "chest", label: "Chest", dist: 1, objectId: "chest_1", items: [{ id: "it_1", name: "Brass key" }, { id: "it_2", name: "Healing draught" }] },
    { id: "cn_2", kind: "remains", label: "Remains of Marsh Brute", dist: 1, items: [{ id: "it_3", name: "Bent dagger" }, { id: "it_4", name: "Healing draught" }] },
    { id: "cn_3", kind: "pile", label: "Dropped items", dist: 9, items: [{ id: "it_5", name: "Far coin" }] },
  ],
  inventory: [{ id: "it_9", name: "Iron lantern" }, { id: "it_10", name: "Rope" }, { id: "it_11", name: "Rope" }],
};

const c = (t: string, over: Partial<IntentContext> = {}) => classifyIntent(t, { ...ctx, ...over });

describe("classifyIntent: object verbs", () => {
  it("open, close, unlock, pick and force a uniquely named target", () => {
    expect(c("open the door")).toEqual({ kind: "mechanical", action: "act", verb: "open", targetId: "door_1", label: "the door" });
    expect(c("I close the door.")).toMatchObject({ verb: "close", targetId: "door_1" });
    expect(c("unlock the door")).toMatchObject({ verb: "unlock", targetId: "door_1" });
    expect(c("pick the lock on the chest")).toMatchObject({ verb: "pick_lock", targetId: "chest_1" });
    expect(c("force open the door")).toMatchObject({ verb: "force", targetId: "door_1" });
    expect(c("break the chest open")).toMatchObject({ verb: "force", targetId: "chest_1" });
    expect(c("let's open the chest")).toMatchObject({ verb: "open", targetId: "chest_1" });
  });

  it("pull, read and examine", () => {
    expect(c("pull the lever")).toMatchObject({ verb: "pull", targetId: "lever_1" });
    expect(c("read the sign")).toMatchObject({ verb: "read", targetId: "sign_1" });
    expect(c("examine the chest")).toMatchObject({ verb: "examine", targetId: "chest_1" });
    expect(c("inspect the door")).toMatchObject({ verb: "examine", targetId: "door_1" });
    expect(c("look at the remains")).toMatchObject({ verb: "examine", targetId: "cn_2" });
    expect(c("look at the altar")).toMatchObject({ verb: "examine", targetId: "altar_1" });
  });

  it("matches a container by its exact name", () => {
    expect(c("open the remains of marsh brute")).toMatchObject({ verb: "open", targetId: "cn_2" });
    expect(c("examine the dropped items")).toMatchObject({ verb: "examine", targetId: "cn_3" });
  });

  it("wrong kind for the verb stays narrative", () => {
    for (const t of ["pull the door", "read the chest", "unlock the lever", "open the lever", "open the sign", "pick the lock on the altar"]) {
      expect(c(t).kind, t).toBe("narrative");
    }
  });

  it("two matching targets are narrative unless exactly one is within reach", () => {
    const twoNear: IntentContext["objects"] = [{ id: "d1", kind: "door", dist: 1 }, { id: "d2", kind: "door", dist: 1 }];
    expect(c("open the door", { objects: twoNear }).kind).toBe("narrative");
    const twoFar: IntentContext["objects"] = [{ id: "d1", kind: "door", dist: 5 }, { id: "d2", kind: "door", dist: 7 }];
    expect(c("open the door", { objects: twoFar }).kind).toBe("narrative");
    const oneNear: IntentContext["objects"] = [{ id: "d1", kind: "door", dist: 1 }, { id: "d2", kind: "door", dist: 7 }];
    expect(c("open the door", { objects: oneNear })).toMatchObject({ verb: "open", targetId: "d1" });
    const noDist: IntentContext["objects"] = [{ id: "d1", kind: "door" }, { id: "d2", kind: "door" }];
    expect(c("open the door", { objects: noDist }).kind).toBe("narrative");
  });

  it("an exact id also names a target", () => {
    const two: IntentContext["objects"] = [{ id: "door_1", kind: "door" }, { id: "door_2", kind: "door" }];
    expect(c("open door_2", { objects: two })).toMatchObject({ verb: "open", targetId: "door_2" });
  });

  it("a chest map object and its container count once", () => {
    expect(c("open the chest")).toMatchObject({ targetId: "chest_1" });
  });
});

describe("classifyIntent: taking, dropping and giving", () => {
  it("takes a named item from an adjacent container", () => {
    expect(c("take the brass key")).toEqual({ kind: "mechanical", action: "take", containerId: "cn_1", itemId: "it_1", label: "Brass key" });
    expect(c("grab the bent dagger")).toMatchObject({ action: "take", containerId: "cn_2", itemId: "it_3" });
    expect(c("pick up the brass key")).toMatchObject({ action: "take", itemId: "it_1" });
    expect(c("I take the bent dagger from the remains")).toMatchObject({ action: "take", containerId: "cn_2" });
    expect(c("take the brass key from the chest")).toMatchObject({ action: "take", containerId: "cn_1" });
  });

  it("an item in two containers is ambiguous unless 'from' names one", () => {
    expect(c("take the healing draught").kind).toBe("narrative");
    expect(c("take the healing draught from the remains")).toMatchObject({ action: "take", containerId: "cn_2", itemId: "it_4" });
  });

  it("items in containers out of reach are not takeable", () => {
    expect(c("take the far coin").kind).toBe("narrative");
  });

  it("takes everything from a named container or the only adjacent one", () => {
    expect(c("take everything from the chest")).toMatchObject({ action: "take_all", containerId: "cn_1" });
    expect(c("loot the chest")).toMatchObject({ action: "take_all", containerId: "cn_1" });
    expect(c("loot the remains")).toMatchObject({ action: "take_all", containerId: "cn_2" });
    expect(c("take all from the remains")).toMatchObject({ action: "take_all", containerId: "cn_2" });
    expect(c("take everything").kind).toBe("narrative"); // two adjacent containers
    const one = { containers: [ctx.containers![0]!] };
    expect(c("take everything", one)).toMatchObject({ action: "take_all", containerId: "cn_1" });
    expect(c("loot the lever").kind).toBe("narrative");
  });

  it("drops a carried item by name", () => {
    expect(c("drop the iron lantern")).toEqual({ kind: "mechanical", action: "drop", itemId: "it_9", label: "Iron lantern" });
    expect(c("I drop my rope")).toMatchObject({ action: "drop", itemId: "it_10" });
    expect(c("drop the sword").kind).toBe("narrative");
  });

  it("gives a carried item to a party member by name", () => {
    expect(c("give the iron lantern to Edda Marrow")).toEqual({ kind: "mechanical", action: "give", itemId: "it_9", toId: "pc_4", label: "Iron lantern to Edda Marrow" });
    expect(c("give the rope to edda")).toMatchObject({ action: "give", toId: "pc_4" });
    expect(c("give the iron lantern to Tov").kind).toBe("narrative"); // two Tovs
    expect(c("give the iron lantern to Mara Venn").kind).toBe("narrative"); // yourself
    expect(c("give the iron lantern to Odalys Brand").kind).toBe("narrative"); // not a party member
    expect(c("give the sword to Edda").kind).toBe("narrative");
  });
});

describe("classifyIntent: conservative with interactions", () => {
  it.each([
    "open the door carefully",
    "carefully open the door",
    "I open the door while Tov watches the hall",
    "open the door and go inside",
    "open the door, quietly",
    "open the door slowly",
    "pull the lever then run",
    "read the sign aloud to everyone",
    "take the brass key and run",
    "take the brass key quietly",
    "take everything and leave",
    "drop the iron lantern into the water",
    "give the iron lantern to Edda Marrow as a gift",
    "unlock the door with the brass key",
    "examine the door for traps",
    "look at the door suspiciously",
    "open the door?",
    "force the lock on the door with my crowbar",
  ])("%s", (t) => {
    expect(c(t).kind).toBe("narrative");
  });

  it("does nothing when the scene has no such thing", () => {
    expect(c("open the door", { objects: [] }).kind).toBe("narrative");
    expect(c("take the brass key", { containers: [] }).kind).toBe("narrative");
    expect(classifyIntent("open the door", { actorId: "pc_1", objects: [], exits: [], entities: [] }).kind).toBe("narrative");
  });
});
