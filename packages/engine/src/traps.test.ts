import { describe, expect, it } from "vitest";
import type { MapObject } from "@aedm/schemas";
import { moveEntity, startCombat } from "./combat.ts";
import { applyDmActions } from "./dm-actions.ts";
import { describeEvent, type EngineEvent } from "./events.ts";
import { describeScene } from "./describe.ts";
import { examine, performAct } from "./interact.ts";
import { followStep } from "./npc-behavior.ts";
import { createRng } from "./rng.ts";
import { containerDiff, effectiveMap, findInteractable, findInteractableAny, isHidden, objectKey, toSnapshot, type GameState } from "./state.ts";
import { hazardTiles } from "./ai-nav.ts";
import { disarm, isArmedTrap, knownTrapTiles, spotCheck, trapDetail } from "./traps.ts";
import { PARTY_IDS, makeWorld, placeAt, spawn, withArchetype, withState } from "./testkit.ts";

const [A, B, C] = PARTY_IDS as [string, string, string]; // Brindle (WIS 10), Tamsin (WIS 13), Orrin (WIS 15)
const MAP = "m_lighthouse";
const rng = (seed = 5) => createRng(seed);
const trap = (id: string, x: number, y: number, extra: Partial<Extract<MapObject, { type: "interactable" }>> = {}): MapObject =>
  ({ type: "interactable", id, kind: "trap", state: "closed", x, y, trap: { dc: 12, dice: "2d6", damage_type: "sharp" }, ...extra });

/** The party off in a far corner, the traps given. */
function world(objects: MapObject[]) {
  const w = makeWorld(7, { objects });
  const s = placeAt(placeAt(placeAt(w.state, A, 2, 2), B, 18, 18), C, 18, 17);
  return { ...w, state: s };
}
const types = (r: { events: { type: string }[] }) => r.events.map((e) => e.type);
const trapState = (s: GameState, id = "trap_1") => findInteractableAny(s, MAP, id)!;

describe("hidden traps do not exist for the table", () => {
  const hidden = world([trap("trap_1", 4, 2, { hidden: true })]).state;
  const shown = withState(hidden, (s) => { s.interactables[objectKey(MAP, "trap_1")] = { revealed: true }; });

  it("is isHidden until revealed, and findInteractable skips it", () => {
    const o = findInteractableAny(hidden, MAP, "trap_1")!;
    expect(isHidden(hidden, MAP, o)).toBe(true);
    expect(findInteractable(hidden, MAP, "trap_1")).toBeUndefined();
    expect(isHidden(shown, MAP, o)).toBe(false);
    expect(findInteractable(shown, MAP, "trap_1")).toBeDefined();
  });
  it("is left out of the map the table gets, and a revealed one has no secret detail", () => {
    const ids = (s: GameState) => (effectiveMap(s, MAP)!.layers.find((l) => l.type === "objectgroup") as { objects: { id?: string }[] }).objects.map((o) => o.id);
    expect(ids(hidden)).not.toContain("trap_1");
    expect(JSON.stringify(toSnapshot(hidden)!.map)).not.toContain("trap_1");
    const seen = (effectiveMap(shown, MAP)!.layers.find((l) => l.type === "objectgroup") as { objects: Record<string, unknown>[] }).objects.find((o) => o.id === "trap_1")!;
    expect(seen).toEqual({ type: "interactable", id: "trap_1", kind: "trap", state: "closed", x: 4, y: 2 });
  });
  it("is not in the scene description until revealed; a revealed armed trap is, a sprung one is not", () => {
    expect(describeScene(hidden, A)).not.toMatch(/trap/i);
    expect(describeScene(shown, A)).toMatch(/a trap, armed/);
    const sprung = withState(shown, (s) => { s.interactables[objectKey(MAP, "trap_1")] = { revealed: true, state: "open" }; });
    expect(describeScene(sprung, A)).not.toMatch(/trap/i);
  });
  it("every player action treats it as nonexistent, in the same words as a made-up id", () => {
    const near = placeAt(hidden, A, 3, 2);
    for (const verb of ["examine", "disarm", "interact", "open", "pull", "pick_lock"] as const) {
      const real = performAct(near, rng(), A, verb, "trap_1");
      const fake = performAct(near, rng(), A, verb, "trap_99");
      expect(real.ok, verb).toBe(false);
      expect(real.error, verb).toBe(fake.error);
    }
    expect(examine(near, rng(), A, "trap_1").error).toBe("there is nothing like that here");
  });
  it("a revealed trap can be examined: armed, then sprung", () => {
    const near = placeAt(shown, A, 3, 2);
    expect(examine(near, rng(), A, "trap_1").text).toMatch(/ready to spring/);
    const sprung = withState(near, (s) => { s.interactables[objectKey(MAP, "trap_1")] = { revealed: true, state: "open" }; });
    expect(examine(sprung, rng(), A, "trap_1").text).toMatch(/harmless/);
  });
  it("revealing produces interactables_revealed with the public object, once", () => {
    const d = containerDiff(hidden, shown, MAP);
    expect(d.interactables_revealed).toEqual([{ map_id: MAP, object: { type: "interactable", id: "trap_1", kind: "trap", state: "closed", x: 4, y: 2 } }]);
    expect(d.interactables_changed).toBeUndefined();
    expect(containerDiff(shown, shown, MAP).interactables_revealed).toBeUndefined();
    expect(containerDiff(hidden, hidden, MAP).interactables_revealed).toBeUndefined();
  });
});

describe("springing a trap", () => {
  const seeds = Array.from({ length: 60 }, (_, i) => i + 1);

  it("a party member walking onto it (hidden or not) stops there, takes the dice and the trap becomes open and revealed", () => {
    for (const hide of [true, false]) {
      const s = world([trap("trap_1", 4, 2, { ...(hide ? { hidden: true } : {}) })]).state;
      const r = moveEntity(s, rng(), A, { x: 7, y: 2 });
      expect(r.ok).toBe(true);
      expect(r.state.entities[A]).toMatchObject({ x: 4, y: 2 });
      expect(types(r)).toContain("trap_sprung");
      const sprung = trapState(r.state);
      expect(effectiveStateOf(r.state, "trap_1")).toBe("open");
      expect(isHidden(r.state, MAP, sprung)).toBe(false);
      expect(isArmedTrap(r.state, MAP, sprung)).toBe(false);
      expect(containerDiff(s, r.state, MAP).interactables_revealed?.length ?? 0).toBe(hide ? 1 : 0);
      // a second walk over the same tile does nothing
      const again = moveEntity(placeAt(r.state, A, 3, 2), rng(), A, { x: 6, y: 2 });
      expect(types(again)).not.toContain("trap_sprung");
    }
  });
  it("a successful save takes half (rounded down), a failed one the full roll; both happen", () => {
    const seen = new Set<boolean>();
    for (const seed of seeds) {
      const r = moveEntity(world([trap("trap_1", 4, 2)]).state, rng(seed), A, { x: 6, y: 2 });
      const sprung = r.events.find((e) => e.type === "trap_sprung") as Extract<EngineEvent, { type: "trap_sprung" }>;
      const dmg = r.events.find((e) => e.type === "damage") as Extract<EngineEvent, { type: "damage" }>;
      const rollTotal = dmg.dice!.reduce((a, b) => a + b, 0);
      const save = r.events.find((e) => e.type === "roll") as Extract<EngineEvent, { type: "roll" }>;
      expect(save.target).toBe(12);
      expect(sprung.saved).toBe(save.outcome === "success");
      expect(sprung.amount).toBe(sprung.saved ? Math.floor(rollTotal / 2) : rollTotal);
      expect(dmg.amount + dmg.absorbed).toBe(sprung.amount);
      expect(dmg.damageType).toBe("sharp");
      expect(sprung).toMatchObject({ mapId: MAP, objectId: "trap_1", x: 4, y: 2, victim: A, victimName: "Brindle Ash" });
      seen.add(sprung.saved);
    }
    expect(seen).toEqual(new Set([true, false]));
  });
  it("is deterministic: the same seed and state give the same events and state", () => {
    const s = world([trap("trap_1", 4, 2)]).state;
    const a = moveEntity(s, rng(9), A, { x: 6, y: 2 });
    const b = moveEntity(s, rng(9), A, { x: 6, y: 2 });
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
  });
  it("enemies never spring map traps; an allied NPC does", () => {
    const s0 = world([trap("trap_1", 10, 10, { hidden: true })]).state;
    const a = withArchetype(s0);
    const s = spawn(a.state, rng(), a.id, 8, 10);
    const enemy = Object.values(s.entities).find((e) => e.kind === "enemy")!;
    const walked = moveEntity(s, rng(), enemy.id, { x: 12, y: 10 });
    expect(walked.ok).toBe(true);
    expect(walked.state.entities[enemy.id]).toMatchObject({ x: 12, y: 10 });
    expect(types(walked)).not.toContain("trap_sprung");
    expect(isArmedTrap(walked.state, MAP, trapState(walked.state))).toBe(true);

    const npc = applyDmActions(s0, rng(), [{ type: "create_npc", name: "Odalys", concept: "A local.", role: "ally", map_id: MAP, x: 8, y: 10, sprite_tags: ["coat"] }], { presentCharacterIds: PARTY_IDS, partyLevel: 1 });
    const id = Object.values(npc.state.npcs).find((n) => n.name === "Odalys")!.id;
    const ally = moveEntity(npc.state, rng(), id, { x: 12, y: 10 });
    expect(types(ally)).toContain("trap_sprung");
    expect(ally.state.entities[id]).toMatchObject({ x: 10, y: 10 });
  });
  it("outside combat a character taken to 0 HP is downed like by any damage, and the party is not defeated", () => {
    const s = withState(world([trap("trap_1", 4, 2, { trap: { dc: 30, dice: "8d12", damage_type: "fire" } })]).state, (x) => { x.entities[A]!.hp = 1; });
    const r = moveEntity(s, rng(), A, { x: 6, y: 2 });
    expect(types(r)).toEqual(expect.arrayContaining(["trap_sprung", "damage", "downed"]));
    expect(r.state.entities[A]).toMatchObject({ hp: 0, x: 4, y: 2, downedRounds: 0 });
    expect(r.state.entities[A]!.conditions.map((c) => c.condition)).toEqual(["prone"]);
    expect(r.state.characters[A]!.hp).toBe(0);
    expect(r.state.combat).toBeNull();
    expect(types(r)).not.toContain("party_downed");
  });
  it("works in combat: it stops the move, and the mover stays in the turn order", () => {
    let s = world([trap("trap_1", 4, 2, { hidden: true })]).state;
    const a = withArchetype(s);
    s = spawn(a.state, rng(), a.id, 10, 2);
    const enemy = Object.values(s.entities).find((e) => e.kind === "enemy")!;
    let c = startCombat(s, rng(), [A, enemy.id], "standard");
    if (c.state.combat!.active_id !== A) c = { ...c, state: withState(c.state, (x) => { x.combat!.active_id = A; x.combat!.cursor = x.combat!.order.findIndex((o) => o.entity_id === A); x.combat!.turn.movementLeft = 6; }) };
    const r = moveEntity(c.state, rng(), A, { x: 6, y: 2 });
    expect(r.ok).toBe(true);
    expect(types(r)).toContain("trap_sprung");
    expect(r.state.entities[A]).toMatchObject({ x: 4, y: 2 });
    expect(r.state.combat!.order.some((o) => o.entity_id === A)).toBe(true);
  });
  it("tells the DM on its next call", () => {
    const r = moveEntity(world([trap("trap_1", 4, 2)]).state, rng(), A, { x: 6, y: 2 });
    const line = describeEvent(r.events.find((e) => e.type === "trap_sprung")!);
    expect(line).toMatch(/^\[engine: Brindle Ash sets off a trap at \(4,2\) and takes \d+ damage/);
  });
  it("a trap with no details uses the data defaults", () => {
    const bare: MapObject = { type: "interactable", id: "trap_1", kind: "trap", state: "closed", x: 4, y: 2 };
    expect(trapDetail(bare as never)).toEqual({ dc: 12, dice: "1d6", damageType: "sharp" });
  });
});

const effectiveStateOf = (s: GameState, id: string): string => (effectiveMap(s, MAP)!.layers.find((l) => l.type === "objectgroup") as { objects: { id?: string; state?: string }[] }).objects.find((o) => o.id === id)!.state!;

describe("passive spotting", () => {
  it("reveals a hidden trap in range and sight when 10 plus the WIS modifier reaches the DC, with no dice", () => {
    const base = world([trap("trap_1", 5, 2, { hidden: true })]).state;
    const orrin = placeAt(base, C, 2, 2); // 10 + 2 = 12 against DC 12
    const r = spotCheck(orrin);
    expect(r.events).toEqual([{ type: "spotted", mapId: MAP, by: C, byName: "Orrin Vale", objectId: "trap_1", kind: "trap", x: 5, y: 2 }]);
    expect(isHidden(r.state, MAP, trapState(r.state))).toBe(false);
    expect(r.state.rngState).toBe(orrin.rngState);
    expect(containerDiff(orrin, r.state, MAP).interactables_revealed).toHaveLength(1);
    expect(describeEvent(r.events[0]!)).toBe("[engine: Orrin Vale notices a trap at (5,2)]");
    // a lower passive score (Brindle: 10 against 12) sees nothing, and the state object is returned untouched
    const brindle = spotCheck(base);
    expect(brindle.events).toEqual([]);
    expect(brindle.state).toBe(base);
    // against DC 10 it is enough
    const easy = world([trap("trap_1", 5, 2, { hidden: true, trap: { dc: 10, dice: "1d6", damage_type: "sharp" } })]).state;
    expect(spotCheck(easy).events.map((e) => e.type)).toEqual(["spotted"]);
  });
  it("needs range, line of sight and a standing spotter", () => {
    const hidden = trap("trap_1", 5, 2, { hidden: true });
    const far = placeAt(world([hidden]).state, C, 12, 2); // 7 tiles
    expect(spotCheck(far).events).toEqual([]);
    const blocked = makeWorld(7, { objects: [hidden], walls: [[3, 1], [3, 2], [3, 3]] }).state;
    expect(spotCheck(placeAt(placeAt(placeAt(blocked, C, 2, 2), A, 18, 18), B, 18, 17)).events).toEqual([]);
    const down = withState(placeAt(world([hidden]).state, C, 2, 2), (s) => { s.entities[C]!.hp = 0; });
    expect(spotCheck(down).events).toEqual([]);
  });
  it("never finds a hidden chest, and ignores traps already revealed or sprung", () => {
    const chest: MapObject = { type: "interactable", id: "chest_1", kind: "chest", state: "closed", hidden: true, x: 4, y: 2 };
    expect(spotCheck(placeAt(world([chest]).state, C, 3, 2)).events).toEqual([]);
    const open = world([trap("trap_1", 5, 2, { hidden: true, state: "open" })]).state;
    expect(spotCheck(placeAt(open, C, 3, 2)).events).toEqual([]);
  });
});

describe("disarming", () => {
  const near = (extra: Partial<Extract<MapObject, { type: "interactable" }>> = {}) =>
    withState(placeAt(world([trap("trap_1", 5, 5, { trap: { dc: 15, dice: "2d6", damage_type: "acid" }, ...extra })]).state, A, 5, 4), (s) => { s.interactables[objectKey(MAP, "trap_1")] = { revealed: true }; });

  it("succeeds on a roll that reaches the DC, softly fails by less than the margin (and may retry), springs on a hard fail", () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) {
      const s = near();
      const r = disarm(s, rng(seed), A, "trap_1");
      expect(r.ok).toBe(true);
      const roll = r.events.find((e) => e.type === "roll") as Extract<EngineEvent, { type: "roll" }>;
      const dc = 15;
      const kind = roll.total >= dc ? "success" : dc - roll.total >= 5 ? "hard" : "soft";
      seen.add(kind);
      if (kind === "success") {
        expect(types(r)).toEqual(["roll", "trap_disarmed"]);
        expect(isArmedTrap(r.state, MAP, trapState(r.state))).toBe(false);
      } else if (kind === "soft") {
        expect(types(r)).toEqual(["roll", "disarm_failed"]);
        expect(isArmedTrap(r.state, MAP, trapState(r.state))).toBe(true);
        expect(disarm(r.state, rng(seed + 1000), A, "trap_1").ok).toBe(true); // retry allowed
      } else {
        const t = types(r);
        expect(t).toEqual(expect.arrayContaining(["roll", "trap_sprung", "damage"]));
        expect(t.filter((x) => x === "roll")).toHaveLength(1); // no save on a hard failure
        expect((r.events.find((e) => e.type === "trap_sprung") as { saved: boolean }).saved).toBe(false);
        expect(isArmedTrap(r.state, MAP, trapState(r.state))).toBe(false);
        expect(r.state.entities[A]!.hp).toBeLessThan(s.entities[A]!.hp);
      }
    }
    expect(seen).toEqual(new Set(["success", "soft", "hard"]));
  });
  it("needs a revealed, armed trap within reach, and a live actor", () => {
    const hiddenTrap = withState(near({ hidden: true }), (s) => { delete s.interactables[objectKey(MAP, "trap_1")]; });
    expect(disarm(hiddenTrap, rng(), A, "trap_1")).toMatchObject({ ok: false, error: "there is no such trap here" });
    expect(disarm(placeAt(near(), A, 2, 2), rng(), A, "trap_1").ok).toBe(false);
    const done = withState(near(), (s) => { s.interactables[objectKey(MAP, "trap_1")] = { revealed: true, state: "open" }; });
    expect(disarm(done, rng(), A, "trap_1")).toMatchObject({ ok: false, error: "that trap is already harmless" });
    expect(disarm(near(), rng(), A, "nothing").ok).toBe(false);
    expect(performAct(near(), rng(3), A, "disarm", "trap_1").ok).toBe(true);
    expect(performAct(near(), rng(3), A, "disarm", "door_9")).toMatchObject({ ok: false, error: "there is no trap to disarm" });
  });
  it("costs the action in combat and is refused out of turn", () => {
    let s = near();
    const a = withArchetype(s);
    s = spawn(a.state, rng(), a.id, 12, 12);
    const enemy = Object.values(s.entities).find((e) => e.kind === "enemy")!;
    const c = startCombat(s, rng(), [A, enemy.id], "standard");
    const mine = withState(c.state, (x) => { x.combat!.active_id = A; x.combat!.cursor = x.combat!.order.findIndex((o) => o.entity_id === A); x.combat!.turn = { movementLeft: 6, actionUsed: false, quickUsed: false }; });
    const r = disarm(mine, rng(2), A, "trap_1");
    expect(r.ok).toBe(true);
    expect(r.state.combat!.turn.actionUsed).toBe(true);
    expect(disarm(r.state, rng(2), A, "trap_1").ok).toBe(false);
    const theirs = withState(mine, (x) => { x.combat!.active_id = enemy.id; });
    expect(disarm(theirs, rng(2), A, "trap_1").ok).toBe(false);
  });
});

describe("known traps and pathing", () => {
  it("knownTrapTiles lists revealed armed traps only", () => {
    const objs = [trap("trap_1", 5, 5), trap("trap_2", 6, 6, { hidden: true }), trap("trap_3", 7, 7, { state: "open" }), trap("trap_4", 8, 8, { hidden: true })];
    const s = withState(world(objs).state, (x) => { x.interactables[objectKey(MAP, "trap_4")] = { revealed: true }; });
    expect([...knownTrapTiles(s, MAP)].sort()).toEqual(["5,5", "8,8"]);
    expect(knownTrapTiles(s, "nowhere").size).toBe(0);
    expect([...hazardTiles(s, { mapId: MAP, kind: "enemy" })].sort()).toEqual(["5,5", "8,8"]);
  });
  it("an ally following the party keeps off a known trap", () => {
    const base = withState(world([trap("trap_1", 9, 9), trap("trap_2", 8, 8), trap("trap_3", 7, 7), trap("trap_4", 10, 10), trap("trap_5", 6, 6)]).state, (x) => {
      for (const id of ["trap_1", "trap_2", "trap_3", "trap_4", "trap_5"]) x.interactables[objectKey(MAP, id)] = { revealed: true };
    });
    const npc = applyDmActions(placeAt(placeAt(placeAt(base, A, 2, 2), B, 3, 2), C, 2, 3), rng(), [{ type: "create_npc", name: "Odalys", concept: "A local.", role: "ally", map_id: MAP, x: 12, y: 12, sprite_tags: ["coat"] }], { presentCharacterIds: PARTY_IDS, partyLevel: 1 });
    const id = Object.values(npc.state.npcs).find((n) => n.name === "Odalys")!.id;
    let s = npc.state;
    for (let i = 0; i < 4; i++) {
      s = followStep(s, rng(i + 1)).state;
      const at = s.entities[id]!;
      expect(knownTrapTiles(s, MAP).has(`${at.x},${at.y}`), `step ${i}`).toBe(false);
    }
    expect(s.entities[id]!.x).toBeLessThan(12);
  });
});
