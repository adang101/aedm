import { describe, expect, it } from "vitest";
import type { Item, MapObject } from "@aedm/schemas";
import { startCombat } from "./combat.ts";
import { containerView, stashPocketsM, stockMapM } from "./containers.ts";
import { INTERACT } from "./data.ts";
import { closeContainer, dropItem, giveItem, openContainer, takeAll, takeItem } from "./inventory.ts";
import { applyDmActions } from "./dm-actions.ts";
import { applyDamage } from "./mutate.ts";
import { createRng } from "./rng.ts";
import { lootCap } from "./rules.ts";
import { cloneState, effectiveState, run, toSnapshot, type GameState } from "./state.ts";
import { PARTY_IDS, makeWorld, placeAt, spawn, withArchetype, withState } from "./testkit.ts";

const [A, B, C] = PARTY_IDS as [string, string, string];
const rng = () => createRng(99);

const chestObj: MapObject = { type: "interactable", id: "chest_1", kind: "chest", state: "closed", x: 12, y: 12 };
const lockedObj: MapObject = { type: "interactable", id: "chest_2", kind: "chest", state: "locked", lock: { dc: 12, key_item_name: "Brass key" }, x: 14, y: 12 };
const slotObj: MapObject = { type: "entity_slot", id: "slot_9", role: "loot", count: 2, x: 16, y: 16 };

const item = (id: string, name = "Bone-carved charm", kind: Item["kind"] = "trinket", value = 6, tier?: number): Item => ({ id, name, kind, value, ...(tier ? { tier } : {}) });

/** A world with two chests and a loot slot; Brindle stands next to chest_1. */
function world(seed = 7) {
  const w = makeWorld(seed, { objects: [chestObj, lockedObj, slotObj] });
  const state = placeAt(placeAt(placeAt(w.state, A, 11, 12), B, 12, 11), C, 3, 3);
  return { ...w, state };
}
const chestOf = (s: GameState, objectId: string) => Object.values(s.containers).find((c) => c.object_id === objectId)!;
const pack = (s: GameState, id: string) => s.characters[id]!.inventory;

describe("stocking", () => {
  it("makes a container for every chest and loot slot when the map is added", () => {
    const { state } = world();
    expect(chestOf(state, "chest_1")).toMatchObject({ kind: "chest", map_id: "m_lighthouse", x: 12, y: 12 });
    expect(chestOf(state, "chest_2")).toMatchObject({ kind: "chest", locked: true, lock: { dc: 12, key_item_name: "Brass key" } });
    expect(chestOf(state, "slot_9")).toMatchObject({ kind: "pile", x: 16, y: 16 });
    expect(chestOf(state, "desk")).toBeDefined(); // the fixture map's own chest
  });
  it("rolls contents within the budget, deterministically", () => {
    const a = world();
    const b = world();
    expect(a.state.containers).toEqual(b.state.containers);
    const budget = Math.floor((lootCap(1) * INTERACT.chest.budgetPct) / 100);
    for (const c of Object.values(a.state.containers).filter((x) => x.kind === "chest")) {
      expect(c.items.reduce((n, i) => n + i.value, 0)).toBeLessThanOrEqual(budget);
      expect(c.items.length).toBeLessThanOrEqual(INTERACT.chest.maxItems);
    }
    const ids = Object.values(a.state.containers).flatMap((c) => c.items.map((i) => i.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("stock is scenery: it does not count against the encounter loot cap", () => {
    expect(world().state.session.lootValueThisEncounter).toBe(0);
  });
  it("a higher party level gives a bigger budget and tier", () => {
    const w = makeWorld(7, { objects: [chestObj] });
    const lvl = withState(w.state, (s) => { for (const c of Object.values(s.characters)) c.level = 10; s.containers = {}; });
    const tiers = new Set<number>();
    let richest = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const s = withState(lvl, (x) => { x.maps.m_lighthouse = { ...x.maps.m_lighthouse!, meta: { ...x.maps.m_lighthouse!.meta, seed } }; });
      const stocked = run(s, rng(), (m) => stockMapM(m, "m_lighthouse"));
      for (const c of Object.values(stocked.state.containers)) {
        richest = Math.max(richest, c.items.reduce((n, i) => n + i.value, 0));
        for (const i of c.items) tiers.add(i.tier ?? 0);
      }
    }
    expect(Math.max(...tiers)).toBeGreaterThan(1);
    expect(richest).toBeGreaterThan(Math.floor((lootCap(1) * INTERACT.chest.budgetPct) / 100));
    expect(richest).toBeLessThanOrEqual(Math.floor((lootCap(10) * INTERACT.chest.budgetPct) / 100));
  });
  it("stocking again changes nothing (each map object is stocked once)", () => {
    const { state } = world();
    const again = run(state, rng(), (m) => stockMapM(m, "m_lighthouse"));
    expect(again.value).toBe(0);
    expect(again.state.containers).toEqual(state.containers);
  });
  it("the snapshot lists containers without their contents", () => {
    const { state } = world();
    const snap = toSnapshot(state)!;
    expect(snap.containers.length).toBeGreaterThanOrEqual(3);
    for (const c of snap.containers) expect(c).not.toHaveProperty("items");
    expect(snap.containers.find((c) => c.object_id === "chest_2")).toMatchObject({ locked: true, open: false });
    expect(snap.map.layers.find((l) => l.type === "objectgroup" && l.objects.some((o) => o.type === "interactable" && o.id === "chest_2" && o.state === "locked"))).toBeDefined();
  });
});

describe("openContainer", () => {
  it("opens an adjacent chest, tells the table, and syncs the map object's state", () => {
    const { state } = world();
    const c = chestOf(state, "chest_1");
    const r = openContainer(state, rng(), A, c.id);
    expect(r.ok).toBe(true);
    expect(r.events.map((e) => e.type)).toContain("container_opened");
    expect(r.state.containers[c.id]!.opened).toBe(true);
    const o = toSnapshot(r.state)!.map.layers.flatMap((l) => (l.type === "objectgroup" ? l.objects : [])).find((x) => x.type === "interactable" && x.id === "chest_1");
    expect(o).toMatchObject({ state: "open" });
    expect(toSnapshot(r.state)!.containers.find((x) => x.id === c.id)!.open).toBe(true);
    expect(containerView(r.state, c.id)!.items).toEqual(c.items);
  });
  it("accepts the chest's object id as well as the container id", () => {
    const { state } = world();
    expect(openContainer(state, rng(), A, "chest_1").ok).toBe(true);
  });
  it("is refused from too far away, leaving the input state untouched", () => {
    const { state } = world();
    const before = JSON.stringify(state);
    const r = openContainer(state, rng(), C, chestOf(state, "chest_1").id);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/next to/);
    expect(r.state).toBe(state);
    expect(JSON.stringify(state)).toBe(before);
  });
  it("reach is data-driven: Chebyshev distance 1 works diagonally, 2 does not", () => {
    const { state } = world();
    const id = chestOf(state, "chest_1").id;
    expect(openContainer(placeAt(state, A, 11, 11), rng(), A, id).ok).toBe(true);
    expect(openContainer(placeAt(state, A, 10, 12), rng(), A, id).ok).toBe(false);
  });
  it("a locked chest refuses and shows no contents", () => {
    const { state } = world();
    const c = chestOf(state, "chest_2");
    const near = placeAt(state, A, 13, 12);
    const r = openContainer(near, rng(), A, c.id);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/locked/);
    expect(containerView(near, c.id)).toMatchObject({ locked: true, items: [] });
  });
  it("closeContainer shuts an open chest", () => {
    const { state } = world();
    const id = chestOf(state, "chest_1").id;
    const open = openContainer(state, rng(), A, id).state;
    const r = closeContainer(open, rng(), A, id);
    expect(r.ok).toBe(true);
    expect(r.state.containers[id]!.opened).toBeFalsy();
    expect(effectiveState(r.state, "m_lighthouse", { type: "interactable", id: "chest_1", kind: "chest", state: "closed", x: 12, y: 12 })).toBe("closed");
  });
  it("only a player character can open things", () => {
    const { state } = world();
    expect(openContainer(state, rng(), "nobody", "chest_1").ok).toBe(false);
    const w = withArchetype(state);
    const sp = spawn(w.state, rng(), w.id, 13, 13);
    const enemy = Object.values(sp.entities).find((e) => e.kind === "enemy")!;
    expect(openContainer(sp, rng(), enemy.id, "chest_1").error).toMatch(/player character/);
  });
});

describe("takeItem and takeAll", () => {
  const stocked = () => {
    const { state } = world();
    const id = chestOf(state, "chest_1").id;
    const s = withState(state, (x) => {
      x.containers[id]!.items = [item("it_a", "Healing draught", "consumable", 25), item("it_b"), item("it_c", "Balanced steel sword", "weapon", 28, 2)];
    });
    return { state: s, id };
  };

  it("moves one item into the pack and opens a closed chest on the way", () => {
    const { state, id } = stocked();
    const r = takeItem(state, rng(), A, id, "it_b");
    expect(r.ok).toBe(true);
    expect(pack(r.state, A).map((i) => i.id)).toEqual(["it_b"]);
    expect(r.state.containers[id]!.items.map((i) => i.id)).toEqual(["it_a", "it_c"]);
    expect(r.state.containers[id]!.opened).toBe(true);
    expect(r.events.map((e) => e.type)).toEqual(["container_opened", "item_taken"]);
    expect(pack(state, A)).toHaveLength(0); // input untouched
  });
  it("gear taken equips like a granted item", () => {
    const { state, id } = stocked();
    const r = takeItem(state, rng(), A, id, "it_c");
    expect(r.state.characters[A]!.weapon_tier).toBe(2);
    expect(r.events.find((e) => e.type === "item_taken")).toMatchObject({ equipped: true, tier: 2 });
  });
  it("refuses a missing item, a far actor and a locked chest", () => {
    const { state, id } = stocked();
    expect(takeItem(state, rng(), A, id, "it_zzz").error).toMatch(/not in there/);
    expect(takeItem(placeAt(state, A, 1, 1), rng(), A, id, "it_b").ok).toBe(false);
    const lockedId = chestOf(state, "chest_2").id;
    expect(takeItem(placeAt(state, A, 13, 12), rng(), A, lockedId, "x").error).toMatch(/locked/);
  });
  it("the pack cap comes from data and is enforced", () => {
    const { state, id } = stocked();
    const full = withState(state, (s) => { s.characters[A]!.inventory = Array.from({ length: INTERACT.inventoryCap }, (_, i) => item(`it_f${i}`)); });
    const r = takeItem(full, rng(), A, id, "it_b");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/pack is full/);
    expect(INTERACT.inventoryCap).toBeLessThanOrEqual(100);
  });
  it("takeAll takes everything that fits and leaves the rest", () => {
    const { state, id } = stocked();
    const r = takeAll(state, rng(), A, id);
    expect(r.ok).toBe(true);
    expect(pack(r.state, A).map((i) => i.id)).toEqual(["it_a", "it_b", "it_c"]);
    expect(r.state.containers[id]!.items).toHaveLength(0);
    expect(r.state.containers[id]).toBeDefined(); // a chest stays, empty
    const nearlyFull = withState(state, (s) => { s.characters[A]!.inventory = Array.from({ length: INTERACT.inventoryCap - 1 }, (_, i) => item(`it_f${i}`)); });
    const p = takeAll(nearlyFull, rng(), A, id);
    expect(p.ok).toBe(true);
    expect(p.state.containers[id]!.items.map((i) => i.id)).toEqual(["it_b", "it_c"]);
    const none = takeAll(withState(state, (s) => { s.characters[A]!.inventory = Array.from({ length: INTERACT.inventoryCap }, (_, i) => item(`it_f${i}`)); }), rng(), A, id);
    expect(none.ok).toBe(false);
    expect(takeAll(r.state, rng(), A, id).error).toMatch(/nothing to take/);
  });
  it("an emptied loot-slot pile is kept as a record (so it is not stocked again) but leaves the snapshot", () => {
    const { state } = world();
    const pile = chestOf(state, "slot_9");
    const there = placeAt(state, A, 15, 16);
    const r = takeAll(there, rng(), A, pile.id);
    expect(pile.items.length).toBeGreaterThan(0);
    expect(r.ok).toBe(true);
    expect(r.state.containers[pile.id]).toBeDefined();
    expect(toSnapshot(r.state)!.containers.some((c) => c.id === pile.id)).toBe(false);
    const re = run(r.state, rng(), (m) => stockMapM(m, "m_lighthouse"));
    expect(re.state.containers[pile.id]!.items).toHaveLength(0);
  });
});

describe("dropItem", () => {
  const holding = () => {
    const { state } = world();
    return withState(state, (s) => { s.characters[A]!.inventory = [item("it_1"), item("it_2", "Bandage roll", "consumable", 6), item("it_w", "Notched iron blade", "weapon", 12, 1), item("it_q", "Brass key", "quest", 0)]; });
  };
  it("creates a pile on the actor's tile and a second drop joins it", () => {
    const s = holding();
    const r1 = dropItem(s, rng(), A, "it_1");
    expect(r1.ok).toBe(true);
    const piles = Object.values(r1.state.containers).filter((c) => c.kind === "pile" && c.x === 11 && c.y === 12);
    expect(piles).toHaveLength(1);
    expect(piles[0]!.items.map((i) => i.id)).toEqual(["it_1"]);
    expect(pack(r1.state, A).map((i) => i.id)).not.toContain("it_1");
    expect(r1.events.map((e) => e.type)).toEqual(["item_dropped"]);
    const r2 = dropItem(r1.state, rng(), A, "it_2");
    expect(Object.values(r2.state.containers).filter((c) => c.kind === "pile" && c.x === 11 && c.y === 12)[0]!.items).toHaveLength(2);
    expect(toSnapshot(r2.state)!.containers.find((c) => c.kind === "pile" && c.x === 11)!.item_count).toBe(2);
  });
  it("a full pile starts another", () => {
    let s = holding();
    s = withState(s, (x) => { x.characters[A]!.inventory = Array.from({ length: INTERACT.pileCap + 1 }, (_, i) => item(`it_p${i}`)); });
    for (let i = 0; i < INTERACT.pileCap + 1; i++) s = dropItem(s, rng(), A, `it_p${i}`).state;
    const here = Object.values(s.containers).filter((c) => c.kind === "pile" && c.x === 11 && c.y === 12);
    expect(here.map((c) => c.items.length).sort()).toEqual([1, INTERACT.pileCap]);
  });
  it("weapons and armor are bound and cannot be dropped; quest items can", () => {
    const s = holding();
    expect(dropItem(s, rng(), A, "it_w").error).toMatch(/bound/);
    expect(dropItem(s, rng(), A, "it_q").ok).toBe(true);
    expect(dropItem(s, rng(), A, "it_nope").error).toMatch(/not carrying/);
  });
  it("what was dropped can be picked up again, and an emptied pile disappears", () => {
    const s = dropItem(holding(), rng(), A, "it_1").state;
    const pile = Object.values(s.containers).find((c) => c.kind === "pile" && c.items.some((i) => i.id === "it_1"))!;
    const r = takeItem(s, rng(), A, pile.id, "it_1");
    expect(r.ok).toBe(true);
    expect(r.state.containers[pile.id]).toBeUndefined();
    expect(pack(r.state, A).map((i) => i.id)).toContain("it_1");
  });
});

describe("giveItem", () => {
  const holding = () => {
    const { state } = world();
    return withState(state, (s) => { s.characters[A]!.inventory = [item("it_1"), item("it_w", "Notched iron blade", "weapon", 12, 1)]; });
  };
  it("passes an item to an adjacent party member", () => {
    const r = giveItem(holding(), rng(), A, "it_1", B);
    expect(r.ok).toBe(true);
    expect(pack(r.state, B).map((i) => i.id)).toEqual(["it_1"]);
    expect(pack(r.state, A).map((i) => i.id)).toEqual(["it_w"]);
    expect(r.events[0]).toMatchObject({ type: "item_given", from: A, to: B });
  });
  it("needs the other character next to the giver", () => {
    expect(giveItem(holding(), rng(), A, "it_1", C).error).toMatch(/not next to you/);
  });
  it("refuses self, unknown people, bound gear and a full pack", () => {
    const s = holding();
    expect(giveItem(s, rng(), A, "it_1", A).ok).toBe(false);
    expect(giveItem(s, rng(), A, "it_1", "ch_nobody").ok).toBe(false);
    expect(giveItem(s, rng(), A, "it_w", B).error).toMatch(/bound/);
    const full = withState(s, (x) => { x.characters[B]!.inventory = Array.from({ length: INTERACT.inventoryCap }, (_, i) => item(`it_f${i}`)); });
    expect(giveItem(full, rng(), A, "it_1", B).error).toMatch(/pack is full/);
    expect(giveItem(s, rng(), A, "it_zzz", B).error).toMatch(/not carrying/);
  });
  it("cannot hand things to a downed character", () => {
    const down = withState(holding(), (x) => { x.entities[B]!.hp = 0; });
    expect(giveItem(down, rng(), A, "it_1", B).ok).toBe(false);
  });
});

describe("in combat", () => {
  function fighting() {
    const { state, rng: r } = world();
    const a = withArchetype(state);
    const sp = spawn(a.state, r, a.id, 18, 18);
    const enemy = Object.values(sp.entities).find((e) => e.kind === "enemy")!;
    const started = startCombat(sp, createRng(5), [...PARTY_IDS, enemy.id], "standard");
    expect(started.ok).toBe(true);
    // make Brindle the active creature with a fresh turn, whatever initiative said
    const s = withState(started.state, (x) => {
      const c = x.combat!;
      c.cursor = c.order.findIndex((o) => o.entity_id === A);
      c.active_id = A;
      c.turn = { movementLeft: 6, actionUsed: false, quickUsed: false };
    });
    return { state: s, active: A, enemyId: enemy.id };
  }
  const stockedFor = (s: GameState) => withState(s, (x) => { x.containers[chestOf(x, "chest_1").id]!.items = [item("it_a"), item("it_b")]; });

  it("taking costs the action: once per turn", () => {
    const f = fighting();
    const s = placeAt(stockedFor(f.state), f.active, 11, 12);
    const id = chestOf(s, "chest_1").id;
    const r = takeItem(s, rng(), f.active, id, "it_a");
    expect(r.ok).toBe(true);
    expect(r.state.combat!.turn.actionUsed).toBe(true);
    expect(takeItem(r.state, rng(), f.active, id, "it_b").error).toMatch(/action/);
  });
  it("dropping and giving cost the quick action", () => {
    const f = fighting();
    const s = withState(placeAt(f.state, f.active, 11, 12), (x) => { x.characters[f.active]!.inventory = [item("it_1"), item("it_2")]; });
    const r = dropItem(s, rng(), f.active, "it_1");
    expect(r.ok).toBe(true);
    expect(r.state.combat!.turn.quickUsed).toBe(true);
    expect(r.state.combat!.turn.actionUsed).toBe(false);
    expect(dropItem(r.state, rng(), f.active, "it_2").error).toMatch(/quick/);
  });
  it("only the active creature may do it", () => {
    const f = fighting();
    const other = PARTY_IDS.find((p) => p !== f.active)!;
    const s = placeAt(stockedFor(f.state), other, 11, 12);
    const r = takeItem(s, rng(), other, chestOf(s, "chest_1").id, "it_a");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/turn/);
  });
  it("a verb the data refuses is refused in combat but fine outside it", () => {
    const f = fighting();
    const prev = INTERACT.combatCost.take;
    INTERACT.combatCost.take = "refuse";
    try {
      const s = placeAt(stockedFor(f.state), f.active, 11, 12);
      expect(takeItem(s, rng(), f.active, chestOf(s, "chest_1").id, "it_a").error).toMatch(/not possible during combat/);
      const calm = placeAt(stockedFor(world().state), A, 11, 12);
      expect(takeItem(calm, rng(), A, chestOf(calm, "chest_1").id, "it_a").ok).toBe(true);
    } finally {
      INTERACT.combatCost.take = prev as typeof INTERACT.combatCost.take;
    }
  });
});

function applyDamageTo(state: GameState, entityId: string, amount: number, r = createRng(2)) {
  return run(state, r, (m) => { applyDamage(m, m.s.entities[entityId]!, amount); });
}
function killViaDamage(state: GameState, seed: number, r = createRng(seed)) {
  return applyDamageTo(state, "ei_t", 9999, r);
}

describe("remains and pockets", () => {
  function foe(state: GameState, role: "minion" | "standard" | "elite" | "boss", at: [number, number] = [8, 8]) {
    const w = withArchetype(state);
    const s = withState(w.state, (x) => {
      x.archetypes[w.id]!.role = role;
      x.entities.ei_t = {
        id: "ei_t", kind: "enemy", name: "Test Foe", mapId: "m_lighthouse", x: at[0], y: at[1], hp: 5, hpMax: 5, conditions: [], shield: 0,
        sprite: x.entities[A]!.sprite, refId: w.id, cooldowns: {}, usesLeft: {}, checkBonuses: [],
      };
    });
    return s;
  }
  it("a boss always leaves remains on its tile, within the encounter loot cap, counted against it", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const s = foe(world().state, "boss");
      const r = killViaDamage(s, seed);
      const remains = Object.values(r.state.containers).filter((c) => c.kind === "remains");
      expect(remains, `seed ${seed}`).toHaveLength(1);
      const c = remains[0]!;
      expect([c.x, c.y]).toEqual([8, 8]);
      expect(c.label).toBe("Remains of Test Foe");
      const value = c.items.reduce((n, i) => n + i.value, 0);
      expect(value).toBeLessThanOrEqual(lootCap(1));
      expect(value).toBeLessThanOrEqual(Math.floor((lootCap(1) * INTERACT.remains.budgetPct.boss!) / 100));
      expect(r.state.session.lootValueThisEncounter).toBe(value);
      expect(c.items.length).toBeLessThanOrEqual(INTERACT.remains.maxItems.boss!);
      expect(r.events.some((e) => e.type === "loot_dropped")).toBe(true);
      expect(r.state.entities.ei_t).toBeUndefined();
    }
  });
  it("remains can be looted like any container", () => {
    const s = killViaDamage(foe(world().state, "boss"), 3).state;
    const c = Object.values(s.containers).find((x) => x.kind === "remains")!;
    const r = takeAll(placeAt(s, A, 8, 9), rng(), A, c.id);
    expect(r.ok).toBe(true);
    expect(pack(r.state, A).length).toBe(c.items.length);
    expect(r.state.containers[c.id]).toBeUndefined();
  });
  it("minions often drop nothing; the weights decide, and both outcomes happen", () => {
    let nothing = 0;
    let some = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const r = killViaDamage(foe(world().state, "minion"), seed);
      if (Object.values(r.state.containers).some((c) => c.kind === "remains")) some++;
      else nothing++;
    }
    expect(nothing).toBeGreaterThan(some);
    expect(some).toBeGreaterThan(0);
  });
  it("nothing drops once the encounter's loot cap is spent", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const s = withState(foe(world().state, "boss"), (x) => { x.session.lootValueThisEncounter = lootCap(1); });
      expect(Object.values(killViaDamage(s, seed).state.containers).some((c) => c.kind === "remains")).toBe(false);
    }
  });
  it("a drop does not advance the rng stream that combat rolls come from", () => {
    const s = foe(world().state, "boss");
    const rngA = createRng(4);
    const rngB = createRng(4);
    run(s, rngA, (m) => { m.s.entities.ei_t!.hp = 0; });
    killViaDamage(s, 4, rngB);
    expect(rngB.state()).toBe(rngA.state());
  });
  it("enemy damage reaches the same code path as a normal defeat in combat", () => {
    const w = world();
    const a = withArchetype(w.state);
    const sp = spawn(a.state, w.rng, a.id, 18, 18);
    const e = Object.values(sp.entities).find((x) => x.kind === "enemy")!;
    const s = withState(sp, (x) => { x.archetypes[a.id]!.role = "boss"; });
    const hit = applyDamageTo(s, e.id, 999);
    expect(Object.values(hit.state.containers).some((c) => c.kind === "remains")).toBe(true);
    expect(hit.events.some((ev) => ev.type === "defeated")).toBe(true);
  });
  it("NPC pockets cannot be opened, and become remains when the NPC dies", () => {
    const w = world();
    const made = applyDmActions(w.state, rng(), [{ type: "create_npc", name: "Odd Pell", concept: "a nervous ferryman", role: "bystander", map_id: "m_lighthouse", x: 13, y: 13, sprite_tags: [] }], { presentCharacterIds: PARTY_IDS, partyLevel: 1 });
    expect(made.rejected).toEqual([]);
    const npc = Object.values(made.state.entities).find((e) => e.kind === "npc")!;
    const stashed = run(made.state, rng(), (m) => { stashPocketsM(m, m.s.entities[npc.id]!, [item("it_key", "Brass key", "quest", 0)]); });
    const pocket = Object.values(stashed.state.containers).find((c) => c.kind === "pockets")!;
    expect(openContainer(placeAt(stashed.state, A, 13, 12), rng(), A, pocket.id).error).toMatch(/not handing that over/);
    expect(toSnapshot(stashed.state)!.containers.some((c) => c.id === pocket.id)).toBe(false);
    const dead = applyDmActions(stashed.state, rng(), [{ type: "set_fact", subject: "Odd Pell", predicate: "is_alive", object: "false" }], { presentCharacterIds: PARTY_IDS, partyLevel: 1 });
    expect(dead.rejected).toEqual([]);
    const remains = Object.values(dead.state.containers).filter((c) => c.kind === "remains");
    expect(remains).toHaveLength(1);
    expect(remains[0]!.items.map((i) => i.name)).toEqual(["Brass key"]);
    expect([remains[0]!.x, remains[0]!.y]).toEqual([13, 13]);
    expect(Object.values(dead.state.containers).some((c) => c.kind === "pockets")).toBe(false);
  });
  it("a creature that flees leaves nothing behind", () => {
    const s = foe(world().state, "boss");
    const r = run(s, rng(), (m) => { delete m.s.entities.ei_t; });
    expect(Object.values(r.state.containers).some((c) => c.kind === "remains")).toBe(false);
  });
});

describe("purity", () => {
  it("no operation changes the state it was given", () => {
    const { state } = world();
    const before = JSON.stringify(state);
    const id = chestOf(state, "chest_1").id;
    openContainer(state, rng(), A, id);
    takeAll(state, rng(), A, id);
    dropItem(state, rng(), A, "nothing");
    giveItem(state, rng(), A, "nothing", B);
    expect(JSON.stringify(state)).toBe(before);
    expect(cloneState(state).containers).toEqual(state.containers);
  });
  it("is deterministic: the same call on the same state gives the same result", () => {
    const { state } = world();
    const id = chestOf(state, "chest_1").id;
    expect(takeAll(state, createRng(1), A, id)).toEqual(takeAll(state, createRng(1), A, id));
  });
});
