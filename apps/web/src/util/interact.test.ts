import type { CharacterView, ContainerSummary, EntityView, GameMap } from "@aedm/schemas";
import { describe, expect, it } from "vitest";
import { EXAMINE_REACH, REACH, itemActions, reachState, targetsOnMap, verbsFor, type Target } from "./interact";

const labels = (t: Target) => verbsFor(t).map((v) => v.label);
const it_ = (kind: string, state: string, extra: Record<string, unknown> = {}): Target =>
  ({ type: "interactable", id: "x", kind, state, x: 0, y: 0, ...extra }) as Target;

describe("verbsFor", () => {
  it("doors: open or close, and the lock verbs only while locked", () => {
    expect(labels(it_("door", "closed"))).toEqual(["Open", "Examine"]);
    expect(labels(it_("door", "open"))).toEqual(["Close", "Examine"]);
    expect(labels(it_("door", "locked"))).toEqual(["Unlock", "Pick lock", "Force", "Examine"]);
  });

  it("offers Unlock only when the lock names a key (or nothing is known about it)", () => {
    expect(labels(it_("door", "locked", { lock: { key_item_name: "Tower key" } }))).toContain("Unlock");
    expect(verbsFor(it_("door", "locked", { lock: { key_item_name: "Tower key" } }))[0]!.hint).toBe("needs Tower key");
    expect(labels(it_("chest", "locked", { lock: {} }))).toEqual(["Pick lock", "Force", "Examine"]);
  });

  it("chests: open, look inside or close, never door verbs", () => {
    expect(labels(it_("chest", "closed"))).toEqual(["Open", "Examine"]);
    expect(labels(it_("chest", "open"))).toEqual(["Look inside", "Close", "Examine"]);
    expect(labels(it_("chest", "locked"))).toEqual(["Unlock", "Pick lock", "Force", "Examine"]);
  });

  it("levers pull, signs read, altars and people get their own", () => {
    expect(labels(it_("lever", "closed"))).toEqual(["Pull", "Examine"]);
    expect(labels(it_("sign", "closed"))).toEqual(["Read", "Examine"]);
    expect(labels(it_("altar", "closed"))).toEqual(["Interact", "Examine"]);
    expect(labels({ type: "npc", id: "n", x: 0, y: 0 })).toEqual(["Talk", "Examine"]);
  });

  it("piles open through container_action; pockets can only be examined", () => {
    const pile = verbsFor({ type: "container", id: "cn_1", kind: "pile", x: 0, y: 0, itemCount: 2 });
    expect(pile[0]).toMatchObject({ send: "container", verb: "open", target_id: "cn_1" });
    expect(labels({ type: "container", id: "c", kind: "pockets", x: 0, y: 0, itemCount: 1 })).toEqual(["Examine"]);
  });
});

describe("reachState", () => {
  const pull = verbsFor(it_("lever", "closed"))[0]!;
  const examine = verbsFor(it_("lever", "closed"))[1]!;
  const read = verbsFor(it_("sign", "closed"))[0]!;

  it("allows verbs next to the target and disables them beyond reach with a reason", () => {
    expect(reachState(pull, { x: REACH, y: 0 }, { x: 0, y: 0 }).disabled).toBe(false);
    const far = reachState(pull, { x: REACH + 1, y: 0 }, { x: 0, y: 0 });
    expect(far).toMatchObject({ disabled: true, hint: "too far" });
  });

  it("examining and reading reach further", () => {
    expect(reachState(examine, { x: EXAMINE_REACH, y: 0 }, { x: 0, y: 0 }).disabled).toBe(false);
    expect(reachState(read, { x: EXAMINE_REACH, y: EXAMINE_REACH }, { x: 0, y: 0 }).disabled).toBe(false);
    expect(reachState(examine, { x: EXAMINE_REACH + 1, y: 0 }, { x: 0, y: 0 }).disabled).toBe(true);
  });

  it("leaves it to the server when my position is unknown", () => {
    expect(reachState(pull, null, { x: 9, y: 9 }).disabled).toBe(false);
  });
});

describe("targetsOnMap", () => {
  const map = { layers: [{ type: "objectgroup", name: "objects", objects: [
    { type: "interactable", id: "chest_a", kind: "chest", state: "locked", lock: { dc: 10 }, x: 1, y: 1 },
    { type: "interactable", id: "sign_a", kind: "sign", state: "closed", x: 2, y: 2 },
  ] }] } as unknown as GameMap;
  const containers: Record<string, ContainerSummary> = {
    cn_1: { id: "cn_1", kind: "chest", x: 1, y: 1, item_count: 2, locked: true, open: false, object_id: "chest_a" },
    cn_2: { id: "cn_2", kind: "pile", x: 4, y: 4, item_count: 1, locked: false, open: false },
  };
  const npc = { id: "n1", kind: "npc", name: "Odalys", x: 3, y: 3 } as EntityView;

  it("merges a chest with its container and lists piles and npcs once", () => {
    const t = targetsOnMap(map, containers, [npc, { ...npc, id: "e1", kind: "enemy" }]);
    expect(t.map((x) => `${x.type}:${x.id}`)).toEqual(["interactable:chest_a", "interactable:sign_a", "container:cn_2", "npc:n1"]);
    expect(t[0]).toMatchObject({ lock: { dc: 10 }, container: { id: "cn_1" } });
  });
});

describe("itemActions", () => {
  const me = { x: 5, y: 5 };
  const ch = (id: string) => ({ id, name: id }) as CharacterView;
  const ents = (x: number) => ({ me: { x: 5, y: 5 }, bo: { x, y: 5 } }) as unknown as Record<string, EntityView>;

  it("never lets weapons or armor move", () => {
    for (const kind of ["weapon", "armor"] as const) {
      const a = itemActions({ kind }, me, "me", [ch("me"), ch("bo")], ents(6));
      expect(a).toMatchObject({ canDrop: false, canGive: false });
      expect(a.dropReason).toMatch(/bound/);
    }
  });

  it("lets other items drop, and give to adjacent party members only", () => {
    const near = itemActions({ kind: "consumable" }, me, "me", [ch("me"), ch("bo")], ents(6));
    expect(near).toMatchObject({ canDrop: true, canGive: true, recipients: [{ id: "bo", name: "bo" }] });
    const far = itemActions({ kind: "quest" }, me, "me", [ch("me"), ch("bo")], ents(9));
    expect(far).toMatchObject({ canDrop: true, canGive: false, recipients: [] });
    expect(far.giveReason).toBeTruthy();
  });
});
