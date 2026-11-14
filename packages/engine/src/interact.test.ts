import { describe, expect, it } from "vitest";
import type { Item, MapObject } from "@aedm/schemas";
import { moveEntity, startCombat } from "./combat.ts";
import { INTERACT } from "./data.ts";
import {
  closeDoor, examine, forceOpen, openDoor, performAct, pickLock, pullLever, readSign, setSignText, signTextOf, unlock,
} from "./interact.ts";
import { dropItem, takeItem } from "./inventory.ts";
import { createRng } from "./rng.ts";
import { restoreState } from "./map-state.ts";
import {
  cloneState, containerDiff, effectiveLock, effectiveState, findInteractable, occupiedTiles, rngFromState, sightBlockers, toSnapshot, type GameState,
} from "./state.ts";
import { hasLineOfSight } from "./map/index.ts";
import { PARTY_IDS, makeWorld, placeAt, spawn, withArchetype, withState } from "./testkit.ts";

const [A, B, C] = PARTY_IDS as [string, string, string];
const rng = (seed = 99) => createRng(seed);
const MAP = "m_lighthouse";

const door = (id: string, x: number, y: number, state: "open" | "closed" | "locked", lock?: { dc: number; key_item_name?: string }): MapObject =>
  ({ type: "interactable", id, kind: "door", state, x, y, ...(lock ? { lock } : {}) });
const OBJECTS: MapObject[] = [
  door("door_1", 6, 6, "closed"),
  door("door_2", 10, 6, "locked", { dc: 10 }),
  door("door_3", 14, 6, "open"),
  door("door_4", 18, 6, "locked", { dc: 30, key_item_name: "Iron key" }),
  door("door_5", 8, 8, "locked", { dc: 5 }),
  { type: "interactable", id: "lever_1", kind: "lever", state: "closed", links: ["door_1", "door_2"], x: 7, y: 7 },
  { type: "interactable", id: "sign_1", kind: "sign", state: "closed", text: "Beware the second step.", x: 4, y: 8 },
  { type: "interactable", id: "sign_2", kind: "sign", state: "closed", x: 5, y: 8 },
  { type: "interactable", id: "altar_1", kind: "altar", state: "closed", x: 3, y: 9 },
  { type: "interactable", id: "chest_1", kind: "chest", state: "closed", x: 12, y: 12 },
  { type: "interactable", id: "chest_2", kind: "chest", state: "locked", lock: { dc: 12, key_item_name: "Brass key" }, x: 14, y: 12 },
];

function world(opts: { walls?: [number, number][] } = {}) {
  const w = makeWorld(7, { objects: OBJECTS, ...(opts.walls ? { walls: opts.walls } : {}) });
  return { ...w, state: placeAt(placeAt(placeAt(w.state, A, 7, 6), B, 15, 15), C, 1, 1) };
}
const key = (id: string, name: string): Item => ({ id, name, kind: "quest", value: 0 });
const doorState = (s: GameState, id: string) => effectiveState(s, MAP, findInteractable(s, MAP, id)!);
const types = (r: { events: { type: string }[] }) => r.events.map((e) => e.type);

describe("doors block movement and sight until opened", () => {
  it("closed and locked doors are blockers, open ones are not", () => {
    const { state } = world();
    const occ = occupiedTiles(state, MAP);
    expect(occ.has("6,6")).toBe(true); // closed
    expect(occ.has("10,6")).toBe(true); // locked
    expect(occ.has("14,6")).toBe(false); // open
    const sight = sightBlockers(state, MAP);
    expect(sight.has("6,6") && sight.has("10,6") && !sight.has("14,6")).toBe(true);
  });
  it("a creature cannot step onto a closed door, and line of sight stops there", () => {
    const { state } = world();
    const r = moveEntity(state, rng(), A, { x: 6, y: 6 });
    expect(r.ok).toBe(false);
    const map = state.maps[MAP]!;
    expect(hasLineOfSight(map, { x: 5, y: 6 }, { x: 7, y: 6 }, sightBlockers(state, MAP))).toBe(false);
    const open = openDoor(state, rng(), A, "door_1").state;
    expect(hasLineOfSight(map, { x: 5, y: 6 }, { x: 7, y: 6 }, sightBlockers(open, MAP))).toBe(true);
    expect(moveEntity(open, rng(), A, { x: 6, y: 6 }).ok).toBe(true);
  });
  it("a door in a wall is the only way through while it is shut (pathfinding sees door state)", () => {
    const walls: [number, number][] = Array.from({ length: 20 }, (_, y) => [6, y] as [number, number]).filter(([, y]) => y !== 6);
    const { state } = world({ walls });
    const s = placeAt(state, A, 5, 6);
    expect(moveEntity(s, rng(), A, { x: 8, y: 6 }).ok).toBe(false);
    const opened = openDoor(s, rng(), A, "door_1");
    expect(opened.ok).toBe(true);
    const through = moveEntity(opened.state, rng(), A, { x: 8, y: 6 });
    expect(through.ok).toBe(true);
    expect(through.state.entities[A]).toMatchObject({ x: 8, y: 6 });
    const shut = closeDoor(placeAt(through.state, A, 7, 6), rng(), A, "door_1");
    expect(shut.ok).toBe(true);
    expect(moveEntity(placeAt(shut.state, A, 5, 6), rng(), A, { x: 8, y: 6 }).ok).toBe(false);
  });
  it("the snapshot shows the door's current state", () => {
    const { state } = world();
    const snap = (s: GameState) => toSnapshot(s)!.map.layers.flatMap((l) => (l.type === "objectgroup" ? l.objects : [])).find((o) => o.type === "interactable" && o.id === "door_1");
    expect(snap(state)).toMatchObject({ state: "closed" });
    expect(snap(openDoor(state, rng(), A, "door_1").state)).toMatchObject({ state: "open" });
    const locked = toSnapshot(state)!.map.layers.flatMap((l) => (l.type === "objectgroup" ? l.objects : [])).find((o) => o.type === "interactable" && o.id === "door_2");
    expect(locked).toMatchObject({ state: "locked", lock: { dc: 10 } });
  });
  it("blocking is a data switch", () => {
    const { state } = world();
    INTERACT.doors.blockWhenClosed = false;
    try {
      expect(occupiedTiles(state, MAP).has("6,6")).toBe(false);
    } finally {
      INTERACT.doors.blockWhenClosed = true;
    }
  });
});

describe("openDoor and closeDoor", () => {
  it("opens a closed door next to the actor and says so", () => {
    const { state } = world();
    const r = openDoor(state, rng(), A, "door_1");
    expect(r.ok).toBe(true);
    expect(doorState(r.state, "door_1")).toBe("open");
    expect(r.events[0]).toMatchObject({ type: "interactable_changed", objectId: "door_1", state: "open", by: A });
    expect(doorState(state, "door_1")).toBe("closed");
  });
  it("refuses a locked door, an open door, a far door and a non-door", () => {
    const { state } = world();
    expect(openDoor(placeAt(state, A, 9, 6), rng(), A, "door_2").error).toMatch(/locked/);
    expect(openDoor(placeAt(state, A, 13, 6), rng(), A, "door_3").error).toMatch(/already open/);
    expect(openDoor(state, rng(), A, "door_2").error).toMatch(/next to it/);
    expect(openDoor(state, rng(), A, "chest_1").error).toMatch(/no such door/);
    expect(openDoor(state, rng(), A, "door_99").error).toMatch(/no such door/);
  });
  it("closing needs an open door and an empty doorway", () => {
    const { state } = world();
    const near = placeAt(state, A, 13, 6);
    expect(closeDoor(near, rng(), A, "door_3").ok).toBe(true);
    expect(closeDoor(state, rng(), A, "door_1").error).toMatch(/already closed/);
    const blocked = placeAt(near, B, 14, 6);
    expect(closeDoor(blocked, rng(), A, "door_3").error).toMatch(/doorway/);
  });
  it("in combat it costs the action", () => {
    const f = fighting();
    const s = placeAt(f.state, A, 7, 6);
    const r = openDoor(s, rng(), A, "door_1");
    expect(r.ok).toBe(true);
    expect(r.state.combat!.turn.actionUsed).toBe(true);
    expect(closeDoor(r.state, rng(), A, "door_1").error).toMatch(/action/);
  });
});

function fighting() {
  const { state, rng: r } = world();
  const a = withArchetype(state);
  const sp = spawn(a.state, r, a.id, 18, 18);
  const enemy = Object.values(sp.entities).find((e) => e.kind === "enemy")!;
  const started = startCombat(sp, createRng(5), [...PARTY_IDS, enemy.id], "standard");
  expect(started.ok).toBe(true);
  const s = withState(started.state, (x) => {
    const c = x.combat!;
    c.cursor = c.order.findIndex((o) => o.entity_id === A);
    c.active_id = A;
    c.turn = { movementLeft: 6, actionUsed: false, quickUsed: false };
  });
  return { state: s };
}

describe("locks", () => {
  it("a matching key opens it with no roll, whatever the DC, and the key stays", () => {
    const base = withState(placeAt(world().state, A, 17, 6), (s) => { s.characters[A]!.inventory = [key("it_k", "iron KEY")]; });
    const r = unlock(base, rng(), A, "door_4");
    expect(r.ok).toBe(true);
    expect(types(r)).toEqual(["unlocked", "interactable_changed"]);
    expect(r.events[0]).toMatchObject({ method: "key" });
    expect(doorState(r.state, "door_4")).toBe("closed");
    expect(effectiveLock(r.state, MAP, findInteractable(r.state, MAP, "door_4")!)).toBeUndefined();
    expect(r.state.characters[A]!.inventory).toHaveLength(1);
    expect(openDoor(r.state, rng(), A, "door_4").ok).toBe(true);
  });
  it("the wrong key, no key or a lock without a keyhole all refuse (and nothing rolls)", () => {
    const near = placeAt(world().state, A, 17, 6);
    expect(unlock(near, rng(), A, "door_4").error).toMatch(/no Iron key/);
    const wrong = withState(near, (s) => { s.characters[A]!.inventory = [key("it_k", "Brass key")]; });
    expect(unlock(wrong, rng(), A, "door_4").ok).toBe(false);
    expect(unlock(placeAt(world().state, A, 9, 6), rng(), A, "door_2").error).toMatch(/no keyhole/);
    expect(unlock(world().state, rng(), A, "door_1").error).toMatch(/not locked|next to it/);
  });
  it("a chest can be unlocked by its object id or its container id", () => {
    const base = withState(placeAt(world().state, A, 13, 12), (s) => { s.characters[A]!.inventory = [key("it_k", "Brass key")]; });
    const r = unlock(base, rng(), A, "chest_2");
    expect(r.ok).toBe(true);
    const c = Object.values(r.state.containers).find((x) => x.object_id === "chest_2")!;
    expect(c.locked).toBeFalsy();
    expect(c.lock).toBeUndefined();
    expect(effectiveState(r.state, MAP, findInteractable(r.state, MAP, "chest_2")!)).toBe("closed");
    const byContainer = unlock(base, rng(), A, Object.values(base.containers).find((x) => x.object_id === "chest_2")!.id);
    expect(byContainer.ok).toBe(true);
  });

  const strong = (s: GameState, id: string, score: "dex" | "str", value = 20) => withState(s, (x) => { x.characters[id]!.scores[score] = value; });

  it("picking: a DEX check against the DC, through the check machinery", () => {
    const near = strong(placeAt(world().state, A, 9, 8), A, "dex"); // dex 20 = +5, DC 5: cannot fail
    const r = pickLock(near, rng(), A, "door_5");
    expect(r.ok).toBe(true);
    expect(r.success).toBe(true);
    expect(types(r)).toEqual(["roll", "unlocked", "interactable_changed"]);
    expect(r.events[0]).toMatchObject({ type: "roll", kind: "check", target: 5 });
    expect(r.events[1]).toMatchObject({ method: "pick" });
    expect(doorState(r.state, "door_5")).toBe("closed");
  });
  it("a failed pick costs only the attempt: the lock stays, there is no noise, and it can be tried again", () => {
    const near = placeAt(world().state, A, 17, 6); // DC 30: cannot succeed for a level 1 character
    const r = pickLock(near, rng(), A, "door_4");
    expect(r.ok).toBe(true);
    expect(r.success).toBe(false);
    expect(types(r)).toEqual(["roll", "lock_failed"]);
    expect(doorState(r.state, "door_4")).toBe("locked");
    expect(pickLock(r.state, rng(), A, "door_4").ok).toBe(true);
  });
  it("picking uses the lockpicking tag bonus", () => {
    const tagged = withState(placeAt(world().state, A, 9, 8), (s) => { s.characters[A]!.trait_tags = ["lockpicking", "stealth"]; });
    const r = pickLock(tagged, rng(), A, "door_5");
    const roll = r.events[0] as { modifier: number };
    const plain = pickLock(placeAt(world().state, A, 9, 8), rng(), A, "door_5").events[0] as { modifier: number };
    expect(roll.modifier - plain.modifier).toBe(2);
  });
  it("forcing: a STR check against DC plus the force bonus; success breaks the lock for good and makes noise", () => {
    const base = strong(placeAt(world().state, A, 9, 8), A, "str");
    let seen = 0;
    for (let seed = 1; seed <= 40 && seen < 1; seed++) {
      const r = forceOpen(base, rng(seed), A, "door_5");
      if (!r.success) continue;
      seen++;
      expect(types(r)).toEqual(["roll", "unlocked", "interactable_changed", "noise"]);
      expect(r.events[0]).toMatchObject({ target: 5 + INTERACT.locks.force.dcBonus });
      expect(r.events[1]).toMatchObject({ method: "force" });
      expect(r.events[3]).toMatchObject({ type: "noise", radius: INTERACT.locks.force.noiseRadius, source: A, x: 8, y: 8 });
      expect(doorState(r.state, "door_5")).toBe("closed");
      expect(effectiveLock(r.state, MAP, findInteractable(r.state, MAP, "door_5")!)).toBeUndefined();
    }
    expect(seen).toBe(1);
  });
  it("a failed force still makes noise", () => {
    const r = forceOpen(placeAt(world().state, A, 17, 6), rng(), A, "door_4");
    expect(r.success).toBe(false);
    expect(types(r)).toEqual(["roll", "lock_failed", "noise"]);
    expect(doorState(r.state, "door_4")).toBe("locked");
  });
  it("the same seed gives the same roll", () => {
    const near = placeAt(world().state, A, 9, 8);
    expect(pickLock(near, rng(3), A, "door_5")).toEqual(pickLock(near, rng(3), A, "door_5"));
    expect(JSON.stringify(pickLock(near, rng(3), A, "door_5").events)).not.toBe(JSON.stringify(pickLock(near, rng(4), A, "door_5").events));
  });
  it("a locked map object with no lock still gets a default DC from data", () => {
    const s = withState(placeAt(world().state, A, 9, 6), (x) => {
      const objs = x.maps[MAP]!.layers.find((l) => l.type === "objectgroup");
      if (objs && objs.type === "objectgroup") objs.objects = objs.objects.map((o) => (o.type === "interactable" && o.id === "door_2" ? { ...o, lock: undefined } : o)) as MapObject[];
    });
    const lock = effectiveLock(s, MAP, findInteractable(s, MAP, "door_2")!);
    expect(lock?.dc).toBe(INTERACT.locks.dcByTier[String(INTERACT.locks.defaultTier)]);
  });
  it("in combat a roll costs the action, win or lose", () => {
    const f = fighting();
    const s = placeAt(f.state, A, 17, 6);
    const r = pickLock(s, rng(), A, "door_4");
    expect(r.state.combat!.turn.actionUsed).toBe(true);
    expect(pickLock(r.state, rng(), A, "door_4").ok).toBe(false);
  });
});

describe("levers", () => {
  it("flip themselves and every linked door: closed and locked doors open, the lock gone", () => {
    const { state } = world();
    const r = pullLever(state, rng(), A, "lever_1");
    expect(r.ok).toBe(true);
    expect(doorState(r.state, "lever_1")).toBe("open");
    expect(doorState(r.state, "door_1")).toBe("open");
    expect(doorState(r.state, "door_2")).toBe("open");
    expect(effectiveLock(r.state, MAP, findInteractable(r.state, MAP, "door_2")!)).toBeUndefined();
    expect(r.events.filter((e) => e.type === "interactable_changed").map((e) => (e as { objectId: string }).objectId)).toEqual(["lever_1", "door_1", "door_2"]);
    expect(r.events.at(-1)).toMatchObject({ type: "lever_pulled", state: "open", affected: ["door_1", "door_2"] });
    expect(doorState(r.state, "door_3")).toBe("open"); // not linked: untouched
  });
  it("pulled again, it flips everything back (open doors close)", () => {
    const { state } = world();
    const once = pullLever(state, rng(), A, "lever_1").state;
    const twice = pullLever(once, rng(), A, "lever_1");
    expect(doorState(twice.state, "lever_1")).toBe("closed");
    expect(doorState(twice.state, "door_1")).toBe("closed");
    expect(doorState(twice.state, "door_2")).toBe("closed");
  });
  it("a door with someone in it stays open", () => {
    const { state } = world();
    const once = pullLever(state, rng(), A, "lever_1").state;
    const stuck = placeAt(once, B, 10, 6);
    const r = pullLever(stuck, rng(), A, "lever_1");
    expect(doorState(r.state, "door_1")).toBe("closed");
    expect(doorState(r.state, "door_2")).toBe("open");
    expect(r.events.at(-1)).toMatchObject({ affected: ["door_1"] });
  });
  it("is deterministic and needs reach", () => {
    const { state } = world();
    expect(pullLever(state, rng(), A, "lever_1")).toEqual(pullLever(state, rng(), A, "lever_1"));
    expect(pullLever(placeAt(state, A, 1, 1), rng(), A, "lever_1").error).toMatch(/next to it/);
    expect(pullLever(state, rng(), A, "door_1").error).toMatch(/no such lever/);
  });
});

describe("signs", () => {
  it("readSign tells the table what is written, with no roll and no DM", () => {
    const near = placeAt(world().state, A, 4, 7);
    const r = readSign(near, rng(), A, "sign_1");
    expect(r.ok).toBe(true);
    expect(r.events).toEqual([{ type: "sign_read", mapId: MAP, objectId: "sign_1", text: "Beware the second step.", by: A, byName: expect.any(String) }]);
  });
  it("a sign nobody wrote on gets a deterministic line from the templates", () => {
    const s = placeAt(world().state, A, 5, 7);
    const a = readSign(s, rng(), A, "sign_2");
    const b = readSign(s, rng(1234), A, "sign_2");
    const text = (a.events[0] as { text: string }).text;
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(200);
    expect((b.events[0] as { text: string }).text).toBe(text); // not from the rng passed in
    expect(text).not.toMatch(/\{.*\}/);
    expect(signTextOf(s, MAP, findInteractable(s, MAP, "sign_2")!)).toBe(text);
  });
  it("can be read from a few tiles away but not across the map", () => {
    const s = world().state;
    expect(readSign(placeAt(s, A, 4, 8 - INTERACT.examineReach), rng(), A, "sign_1").ok).toBe(true);
    expect(readSign(placeAt(s, A, 15, 15), rng(), A, "sign_1").ok).toBe(false);
    expect(readSign(placeAt(s, A, 4, 7), rng(), A, "door_1").error).toMatch(/no such sign/);
  });
  it("setSignText writes the text (1 to 200 characters), and reads back", () => {
    const s = world().state;
    const w = setSignText(s, MAP, "sign_2", "  The cellar is flooded.  ");
    expect(w.ok).toBe(true);
    expect(w.events).toEqual([{ type: "sign_written", mapId: MAP, objectId: "sign_2", text: "The cellar is flooded." }]);
    expect((readSign(placeAt(w.state, A, 5, 7), rng(), A, "sign_2").events[0] as { text: string }).text).toBe("The cellar is flooded.");
    const snapSign = toSnapshot(w.state)!.map.layers.flatMap((l) => (l.type === "objectgroup" ? l.objects : [])).find((o) => o.type === "interactable" && o.id === "sign_2");
    expect(snapSign).toMatchObject({ text: "The cellar is flooded." });
    expect(setSignText(s, MAP, "sign_2", "x".repeat(200)).ok).toBe(true);
    expect(setSignText(s, MAP, "sign_2", "x".repeat(201)).ok).toBe(false);
    expect(setSignText(s, MAP, "sign_2", "   ").ok).toBe(false);
    expect(setSignText(s, MAP, "door_1", "hi").error).toMatch(/no sign/);
    expect(setSignText(s, "m_nowhere", "sign_2", "hi").ok).toBe(false);
    expect(setSignText(s, MAP, "sign_2", "x".repeat(201)).state).toBe(s);
  });
  it("reading costs nothing in combat, even out of turn", () => {
    const f = fighting();
    const s = placeAt(f.state, B, 4, 7);
    const r = readSign(s, rng(), B, "sign_1");
    expect(r.ok).toBe(true);
    expect(r.state.combat!.turn.actionUsed).toBe(false);
  });
});

describe("examine", () => {
  const line = (s: GameState, id: string, who = A) => examine(s, rng(), who, id);
  it("describes a chest by its state, and an open one by how much it holds", () => {
    const base = placeAt(world().state, A, 13, 12);
    expect(line(base, "chest_1").text).toBe("A chest, closed but not locked.");
    expect(line(base, "chest_2").text).toBe("A chest, shut tight and locked.");
    const open = withState(base, (s) => {
      const c = Object.values(s.containers).find((x) => x.object_id === "chest_1")!;
      c.opened = true;
      c.items = c.items.slice(0, 2);
      while (c.items.length < 2) c.items.push({ id: `it_x${c.items.length}`, name: "Bone-carved charm", kind: "trinket", value: 6 });
    });
    expect(line(open, "chest_1").text).toBe("An open chest holding 2 items.");
    const empty = withState(open, (s) => { Object.values(s.containers).find((x) => x.object_id === "chest_1")!.items = []; });
    expect(line(empty, "chest_1").text).toBe("An open chest, empty.");
    const one = withState(open, (s) => { Object.values(s.containers).find((x) => x.object_id === "chest_1")!.items.length = 1; });
    expect(line(one, "chest_1").text).toBe("An open chest holding 1 item.");
  });
  it("closed containers never give away their contents", () => {
    const base = placeAt(world().state, A, 13, 12);
    expect(line(base, "chest_1").text).not.toMatch(/\d/);
  });
  it("describes doors, levers and signs", () => {
    const s = placeAt(world().state, A, 7, 7);
    expect(line(s, "door_1").text).toBe("A door, closed.");
    expect(line(s, "door_2").text).toBe("A door, closed and locked.");
    expect(line(s, "lever_1").text).toBe("A lever, pushed up.");
    expect(line(pullLever(s, rng(), A, "lever_1").state, "lever_1").text).toBe("A lever, pulled down.");
    expect(line(openDoor(s, rng(), A, "door_1").state, "door_1").text).toBe("A door, standing open.");
    expect(line(placeAt(s, A, 4, 7), "sign_1").text).toBe("A sign with writing on it.");
  });
  it("describes a pile and remains", () => {
    const dropped = dropItem(withState(placeAt(world().state, A, 9, 9), (s) => { s.characters[A]!.inventory = [{ id: "it_1", name: "Bone-carved charm", kind: "trinket", value: 6 }]; }), rng(), A, "it_1");
    const pile = Object.values(dropped.state.containers).find((c) => c.kind === "pile" && c.x === 9)!;
    expect(line(dropped.state, pile.id).text).toBe("A pile of dropped items (1 item).");
    const remains = withState(dropped.state, (s) => { s.containers[pile.id]!.kind = "remains"; s.containers[pile.id]!.label = "Remains of Robed Chorister"; });
    expect(line(remains, pile.id).text).toBe("The remains of Robed Chorister (1 item).");
  });
  it("hands anything else to the DM: altars, creatures, NPC pockets", () => {
    const s = placeAt(world().state, A, 4, 9);
    const altar = examine(s, rngFromState(s), A, "altar_1");
    expect(altar).toMatchObject({ ok: true, narrative: true, events: [] });
    expect(altar.text).toBeUndefined();
    expect(altar.state).toEqual(s);
    expect(line(s, B)).toMatchObject({ ok: true, narrative: true });
  });
  it("needs a target in view (within the examine reach) and a real one", () => {
    const s = world().state;
    expect(line(placeAt(s, A, 18, 18), "door_1").error).toMatch(/within/);
    expect(line(s, "nothing_here").error).toMatch(/nothing like that/);
  });
  it("is free in combat, even out of turn", () => {
    const f = fighting();
    const r = line(placeAt(f.state, B, 6, 7), "door_1", B);
    expect(r.ok).toBe(true);
    expect(r.state.combat!.turn.actionUsed).toBe(false);
  });
});

describe("performAct: the one call for the act message", () => {
  it("interact does the natural thing for each kind", () => {
    const s = placeAt(world().state, A, 7, 6);
    const opened = performAct(s, rng(), A, "interact", "door_1");
    expect(opened.ok && doorState(opened.state, "door_1") === "open").toBe(true);
    expect(doorState(performAct(opened.state, rng(), A, "interact", "door_1").state, "door_1")).toBe("closed");
    expect(doorState(performAct(s, rng(), A, "interact", "lever_1").state, "lever_1")).toBe("open");
    expect(types(performAct(placeAt(s, A, 4, 7), rng(), A, "interact", "sign_1"))).toEqual(["sign_read"]);
    expect(performAct(placeAt(s, A, 4, 9), rng(), A, "interact", "altar_1")).toMatchObject({ ok: true, narrative: true });
    expect(performAct(s, rng(), A, "interact", B)).toMatchObject({ ok: true, narrative: true });
  });
  it("interact on a chest opens it and names the container for container_view", () => {
    const s = placeAt(world().state, A, 13, 12);
    const r = performAct(s, rng(), A, "interact", "chest_1");
    expect(r.ok).toBe(true);
    expect(r.containerId).toBe(Object.values(s.containers).find((c) => c.object_id === "chest_1")!.id);
    expect(performAct(s, rng(), A, "open", "chest_1").containerId).toBe(r.containerId);
    expect(performAct(s, rng(), A, "open", r.containerId!).ok).toBe(true);
  });
  it("interact on a locked thing unlocks it first when the actor carries its key", () => {
    const withKey = withState(placeAt(world().state, A, 17, 6), (s) => { s.characters[A]!.inventory = [key("it_k", "Iron key")]; });
    const r = performAct(withKey, rng(), A, "interact", "door_4");
    expect(types(r)).toEqual(["unlocked", "interactable_changed"]);
    expect(doorState(performAct(r.state, rng(), A, "interact", "door_4").state, "door_4")).toBe("open");
    const noKey = performAct(placeAt(world().state, A, 17, 6), rng(), A, "interact", "door_4");
    expect(noKey).toMatchObject({ ok: false });
    expect(noKey.error).toMatch(/locked/);
  });
  it("the explicit verbs map to the right operations and refuse the wrong targets", () => {
    const s = placeAt(world().state, A, 7, 6);
    expect(performAct(s, rng(), A, "open", "door_1").ok).toBe(true);
    expect(performAct(s, rng(), A, "close", "door_1").error).toMatch(/already closed/);
    expect(performAct(s, rng(), A, "pull", "lever_1").ok).toBe(true);
    expect(performAct(s, rng(), A, "pull", "door_1").ok).toBe(false);
    expect(performAct(s, rng(), A, "read", "door_1").ok).toBe(false);
    expect(performAct(placeAt(s, A, 4, 7), rng(), A, "read", "sign_1").ok).toBe(true);
    expect(performAct(s, rng(), A, "open", "lever_1").ok).toBe(false);
    expect(performAct(s, rng(), A, "unlock", "sign_1").ok).toBe(false);
    expect(performAct(s, rng(), A, "pick_lock", "lever_1").ok).toBe(false);
    expect(performAct(s, rng(), A, "force", "door_zz").ok).toBe(false);
    expect(performAct(s, rng(), A, "examine", "door_1").text).toBe("A door, closed.");
    expect(performAct(s, rng(), A, "talk", B)).toMatchObject({ ok: true, narrative: true });
    expect(performAct(s, rng(), A, "talk", "door_1").ok).toBe(false);
    expect(performAct(s, rng(), A, "interact", "nothing")).toMatchObject({ ok: false, narrative: false });
  });
  it("lock verbs report the roll", () => {
    const strong = withState(placeAt(world().state, A, 9, 8), (s) => { s.characters[A]!.scores.dex = 20; });
    const r = performAct(strong, rng(), A, "pick_lock", "door_5");
    expect(r).toMatchObject({ ok: true, success: true, narrative: false });
    expect(performAct(placeAt(world().state, A, 17, 6), rng(), A, "force", "door_4")).toMatchObject({ ok: true, success: false });
  });
  it("a refused act leaves the state alone and says why", () => {
    const s = world().state;
    const r = performAct(s, rng(), A, "open", "door_2");
    expect(r.ok).toBe(false);
    expect(r.state).toBe(s);
    expect(r.events[0]).toMatchObject({ type: "action_rejected" });
  });
});

describe("containerDiff (the state_diff fields)", () => {
  it("reports nothing when nothing changed", () => {
    const s = world().state;
    expect(containerDiff(s, s, MAP)).toEqual({});
  });
  it("reports a door, a lever and its linked doors", () => {
    const s = world().state;
    const d = containerDiff(s, pullLever(s, rng(), A, "lever_1").state, MAP);
    expect(d.interactables_changed).toEqual(expect.arrayContaining([
      { map_id: MAP, id: "door_1", state: "open" }, { map_id: MAP, id: "door_2", state: "open" }, { map_id: MAP, id: "lever_1", state: "open" },
    ]));
    expect(d.interactables_changed).toHaveLength(3);
    expect(d.containers_changed).toBeUndefined();
  });
  it("reports an opened chest as a container and an interactable change, and an emptied pile as removed", () => {
    const s = placeAt(world().state, A, 13, 12);
    const opened = performAct(s, rng(), A, "open", "chest_1").state;
    const d = containerDiff(s, opened, MAP);
    expect(d.containers_changed).toHaveLength(1);
    expect(d.containers_changed![0]).toMatchObject({ object_id: "chest_1", open: true });
    expect(d.interactables_changed).toEqual([{ map_id: MAP, id: "chest_1", state: "open" }]);
    const dropped = dropItem(withState(placeAt(s, A, 9, 9), (x) => { x.characters[A]!.inventory = [key("it_1", "Bone-carved charm")]; }), rng(), A, "it_1").state;
    const pile = Object.values(dropped.containers).find((c) => c.kind === "pile" && c.x === 9)!;
    expect(containerDiff(s, dropped, MAP).containers_changed?.[0]).toMatchObject({ id: pile.id, item_count: 1 });
    const gone = takeItem(dropped, rng(), A, pile.id, "it_1").state;
    expect(containerDiff(dropped, gone, MAP)).toEqual({ containers_removed: [pile.id] });
  });
});

describe("saves", () => {
  it("door, lever, sign and container changes survive a JSON round trip", () => {
    let s = world().state;
    s = openDoor(s, rng(), A, "door_1").state;
    s = setSignText(s, MAP, "sign_2", "Wet paint.").state;
    s = performAct(placeAt(s, A, 13, 12), rng(), A, "open", "chest_1").state;
    const back = restoreState(JSON.parse(JSON.stringify(s)));
    expect(back.containers).toEqual(s.containers);
    expect(back.interactables).toEqual(s.interactables);
    expect(doorState(back, "door_1")).toBe("open");
    expect(toSnapshot(back)).toEqual(toSnapshot(s));
    expect(JSON.stringify(restoreState(JSON.parse(JSON.stringify(back))))).toBe(JSON.stringify(back));
  });
  it("a save from before containers loads: missing fields default, chests get stocked, nothing else changes", () => {
    const s = world().state;
    const old = JSON.parse(JSON.stringify(s));
    delete old.containers;
    delete old.interactables;
    const loaded = restoreState(old);
    expect(loaded.interactables).toEqual({});
    expect(Object.values(loaded.containers).filter((c) => c.kind === "chest")).toHaveLength(3);
    expect(loaded.characters).toEqual(s.characters);
    expect(loaded.maps).toEqual(s.maps);
    // and play carries on
    expect(openDoor(placeAt(loaded, A, 7, 6), rng(), A, "door_1").ok).toBe(true);
  });
  it("restoreState is a no-op on a current state", () => {
    const s = world().state;
    const r = restoreState(JSON.parse(JSON.stringify(s)));
    expect(r.containers).toEqual(s.containers);
    expect(r.nextId).toBe(s.nextId);
  });
});

describe("purity", () => {
  it("no operation changes its input", () => {
    const s = placeAt(world().state, A, 7, 7);
    const before = JSON.stringify(s);
    openDoor(s, rng(), A, "door_1");
    pullLever(s, rng(), A, "lever_1");
    pickLock(s, rng(), A, "door_1");
    forceOpen(s, rng(), A, "door_2");
    examine(s, rng(), A, "lever_1");
    setSignText(s, MAP, "sign_1", "new");
    performAct(s, rng(), A, "interact", "chest_1");
    expect(JSON.stringify(s)).toBe(before);
    expect(JSON.stringify(cloneState(s))).toBe(before);
  });
});
