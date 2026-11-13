import { describe, expect, it } from "vitest";
import type { DmAction, MapObject } from "@aedm/schemas";
import { startCombat } from "./combat.ts";
import { INTERACT } from "./data.ts";
import { applyDmActions, type DmContext } from "./dm-actions.ts";
import { createRng } from "./rng.ts";
import { cloneState, effectiveLock, effectiveState, effectiveText, findInteractable, type GameState } from "./state.ts";
import { PARTY_IDS, makeWorld, placeAt, spawn, withArchetype } from "./testkit.ts";

const CTX: DmContext = { presentCharacterIds: PARTY_IDS, partyLevel: 1 };
const apply = (state: GameState, actions: DmAction[], ctx: DmContext = CTX) => applyDmActions(state, createRng(3), actions, ctx);
const MAP = "m_lighthouse";

const objects: MapObject[] = [
  { type: "interactable", id: "chest_1", kind: "chest", state: "closed", x: 12, y: 12 },
  { type: "interactable", id: "door_1", kind: "door", state: "closed", x: 6, y: 6 },
  { type: "interactable", id: "door_2", kind: "door", state: "open", x: 8, y: 6 },
  { type: "interactable", id: "sign_1", kind: "sign", state: "closed", x: 4, y: 8 },
  { type: "interactable", id: "lever_1", kind: "lever", state: "closed", x: 7, y: 7 },
];
const world = () => makeWorld(7, { objects });
const chestId = (s: GameState) => Object.values(s.containers).find((c) => c.object_id === "chest_1")!.id;
const stock = (container_id: string, ...items: { name: string; value: number; kind?: "trinket" | "quest" | "weapon"; tier?: number }[]): DmAction => ({
  type: "stock_container", container_id,
  items: items.map((i) => ({ name: i.name, kind: i.kind ?? "trinket", value: i.value, ...(i.tier ? { tier: i.tier } : {}) })),
});
const npc = (name: string): DmAction => ({ type: "create_npc", name, concept: "A local.", role: "bystander", map_id: MAP, x: 5, y: 5, sprite_tags: ["coat"] });

describe("stock_container", () => {
  it("stocks a chest by container id or by its map object id, and counts the value against the loot cap", () => {
    const { state } = world();
    const cid = chestId(state);
    const before = state.containers[cid]!.items.length;
    const r = apply(state, [stock(cid, { name: "Silver ring", value: 20 }), stock("chest_1", { name: "Brass key", value: 0, kind: "quest" })]);
    expect(r.rejected).toEqual([]);
    const items = r.state.containers[cid]!.items;
    expect(items.map((i) => i.name)).toEqual(expect.arrayContaining(["Silver ring", "Brass key"]));
    expect(items).toHaveLength(before + 2);
    expect(new Set(items.map((i) => i.id)).size).toBe(before + 2);
    expect(r.state.session.lootValueThisEncounter).toBe(20);
    expect(r.events.map((e) => e.type)).toContain("container_stocked");
  });

  it("refuses over the remaining cap (all or nothing), gear above the tier allowance and full containers", () => {
    const { state } = world();
    const cid = chestId(state);
    const over = apply(state, [stock(cid, { name: "Pearl", value: 20 }, { name: "Ruby", value: 20 })]);
    expect(over.rejected[0]!.reason).toMatch(/loot cap/);
    expect(over.state.containers[cid]!.items).toEqual(state.containers[cid]!.items);
    expect(over.state.session.lootValueThisEncounter).toBe(0);
    const gear = apply(state, [stock(cid, { name: "Fine sword", value: 5, kind: "weapon", tier: 2 })]);
    expect(gear.rejected[0]!.reason).toMatch(/tier 2/);
    const full = cloneState(state);
    full.containers[cid]!.items = Array.from({ length: INTERACT.pileCap }, (_, i) => ({ id: `it_f${i}`, name: "Pebble", kind: "trinket" as const, value: 0 }));
    expect(apply(full, [stock(cid, { name: "One more", value: 0 })]).rejected[0]!.reason).toMatch(/full/);
  });

  it("quest items are free, and unknown or unsuitable targets are rejected", () => {
    const { state } = world();
    const r = apply(state, [
      stock("chest_1", { name: "Iron key", value: 500, kind: "quest" }),
      stock("cn_nope", { name: "x", value: 1 }), stock("door_1", { name: "x", value: 1 }), stock("ch_orrin", { name: "x", value: 1 }),
    ]);
    expect(r.applied).toHaveLength(1);
    expect(r.rejected).toHaveLength(3);
    expect(r.state.session.lootValueThisEncounter).toBe(0);
    expect(r.state.containers[chestId(r.state)]!.items.find((i) => i.name === "Iron key")!.value).toBe(0);
  });

  it("fills a living NPC's pockets once (later stock joins them)", () => {
    const { state } = world();
    const made = apply(state, [npc("Odalys Brand")]).state;
    const id = Object.keys(made.npcs)[0]!;
    const r = apply(made, [stock(id, { name: "Cellar key", value: 0, kind: "quest" })]);
    expect(r.rejected).toEqual([]);
    const pockets = Object.values(r.state.containers).find((c) => c.kind === "pockets" && c.owner_entity_id === id)!;
    expect(pockets.items.map((i) => i.name)).toEqual(["Cellar key"]);
    const again = apply(r.state, [stock(id, { name: "Locket", value: 5 })]);
    expect(Object.values(again.state.containers).filter((c) => c.kind === "pockets")).toHaveLength(1);
    expect(apply(made, [stock("npc_nobody", { name: "x", value: 1 })]).rejected).toHaveLength(1);
  });
});

describe("set_sign_text", () => {
  it("writes a sign on the current map and rejects non-signs and unknown ids", () => {
    const { state } = world();
    const r = apply(state, [
      { type: "set_sign_text", object_id: "sign_1", text: "The ferry is gone." },
      { type: "set_sign_text", object_id: "door_1", text: "nope" },
      { type: "set_sign_text", object_id: "sign_9", text: "nope" },
    ]);
    expect(r.applied).toHaveLength(1);
    expect(r.rejected).toHaveLength(2);
    expect(effectiveText(r.state, MAP, findInteractable(r.state, MAP, "sign_1")!)).toBe("The ferry is gone.");
  });
});

describe("set_lock", () => {
  it("locks a door or chest as a story beat, with an optional key name", () => {
    const { state } = world();
    const cid = chestId(state);
    const r = apply(state, [
      { type: "set_lock", target_id: "door_1", dc: 15, key_item_name: "Brass key" },
      { type: "set_lock", target_id: cid, dc: 8 },
      { type: "set_lock", target_id: "door_2", dc: 12 }, // an open door is shut and locked
    ]);
    expect(r.rejected).toEqual([]);
    const d1 = findInteractable(r.state, MAP, "door_1")!;
    expect(effectiveState(r.state, MAP, d1)).toBe("locked");
    expect(effectiveLock(r.state, MAP, d1)).toEqual({ dc: 15, key_item_name: "Brass key" });
    expect(r.state.containers[cid]).toMatchObject({ locked: true, lock: { dc: 8 } });
    expect(effectiveState(r.state, MAP, findInteractable(r.state, MAP, "door_2")!)).toBe("locked");
  });

  it("rejects other objects, unknown targets and a creature in the doorway", () => {
    const { state } = world();
    const r = apply(state, [
      { type: "set_lock", target_id: "lever_1", dc: 10 },
      { type: "set_lock", target_id: "door_9", dc: 10 },
      { type: "set_lock", target_id: "sign_1", dc: 10 },
    ]);
    expect(r.rejected).toHaveLength(3);
    const blocked = placeAt(state, "ch_orrin", 8, 6);
    expect(apply(blocked, [{ type: "set_lock", target_id: "door_2", dc: 10 }]).rejected[0]!.reason).toMatch(/doorway/);
  });
});

describe("combat", () => {
  it("refuses all three while a fight is on", () => {
    const w = world();
    const a = withArchetype(w.state);
    const state = spawn(a.state, w.rng, a.id, 9, 9);
    const enemy = Object.values(state.entities).find((e) => e.kind === "enemy")!.id;
    const fight = startCombat(state, w.rng, [...PARTY_IDS, enemy], "standard");
    expect(fight.ok).toBe(true);
    const r = apply(fight.state, [
      stock("chest_1", { name: "x", value: 1 }),
      { type: "set_sign_text", object_id: "sign_1", text: "x" },
      { type: "set_lock", target_id: "door_1", dc: 10 },
    ]);
    expect(r.rejected.map((x) => x.reason)).toEqual([
      "stock_container is not allowed during combat", "set_sign_text is not allowed during combat", "set_lock is not allowed during combat",
    ]);
  });
});
