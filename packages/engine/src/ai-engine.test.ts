import { describe, expect, it } from "vitest";
import type { Ability, Enemy } from "@aedm/schemas";
import { enemyTakeTurn, startCombat, type ActionResult } from "./combat.ts";
import type { EngineEvent } from "./events.ts";
import type { Rng } from "./rng.ts";
import { cloneState, type GameState, type TerrainTile } from "./state.ts";
import { chorister, makeWorld, PARTY_IDS, spawn, withArchetype } from "./testkit.ts";

type At = [number, number];
interface FoeSpec { enemy: Enemy; at: At; hp?: number }
type PcSpec = Partial<Record<"ch_brindle" | "ch_tamsin" | "ch_orrin", [number, number, number?, number?]>>;

const FAR: Record<string, At> = { ch_brindle: [1, 1], ch_tamsin: [1, 2], ch_orrin: [2, 1] };
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

const foe = (name: string, behavior: string[], role: Enemy["role"] = "standard", abilities: Ability[] = [], speed = 6): Enemy => ({
  ...chorister, name, role, behavior, abilities, stats: { ...chorister.stats, hp: 5, speed },
});

const save = { ability: "dex", dc: "caster_dc" } as const;
const ab = (name: string, target: Ability["target"], range: number, effects: Ability["effects"]): Ability => ({
  v: 1, name, description: `${name}.`, tags: [], action: "action", target, range_tiles: range, cooldown_turns: 2, effects,
});

function scene(foes: FoeSpec[], pcs: PcSpec, opts: { seed?: number; walls?: [number, number][]; terrain?: [number, number][] } = {}) {
  const w = makeWorld(opts.seed ?? 7, opts.walls ? { walls: opts.walls } : {});
  let state = w.state;
  const ids: string[] = [];
  for (const f of foes) {
    const a = withArchetype(state, f.enemy);
    state = spawn(a.state, w.rng, a.id, f.at[0], f.at[1]);
    ids.push(Object.values(state.entities).find((e) => e.kind === "enemy" && !ids.includes(e.id))!.id);
  }
  const s = cloneState(state);
  for (const id of PARTY_IDS) {
    const [x, y, hp, hpMax] = pcs[id as keyof PcSpec] ?? [...(FAR[id] as At)];
    Object.assign(s.entities[id]!, { x, y, ...(hp !== undefined ? { hp } : {}), ...(hpMax !== undefined ? { hpMax } : {}) });
  }
  foes.forEach((f, i) => { if (f.hp !== undefined) s.entities[ids[i]!]!.hp = f.hp; });
  (opts.terrain ?? []).forEach(([x, y], i) => {
    const t: TerrainTile = { id: `tr_t${i}`, mapId: "m_lighthouse", x, y, kind: "fire", turns: 9, ownerId: "none", side: "party", dice: "1d6", damageType: "fire" };
    s.terrain.push(t);
  });
  const r = startCombat(s, w.rng, [...PARTY_IDS, ...ids], "standard");
  expect(r.ok).toBe(true);
  return { state: r.state, rng: w.rng, ids };
}

function turn(state: GameState, rng: Rng, id: string, mutate?: (s: GameState) => void): ActionResult {
  const s = cloneState(state);
  const c = s.combat!;
  c.cursor = c.order.findIndex((o) => o.entity_id === id);
  c.active_id = id;
  c.turn = { movementLeft: 6, actionUsed: false, quickUsed: false };
  mutate?.(s);
  return enemyTakeTurn(s, rng, id);
}

const used = (events: EngineEvent[]) => events.filter((e) => e.type === "ability_used");
const saved = (events: EngineEvent[]) => new Set(events.flatMap((e) => (e.type === "roll" && e.kind === "save" ? [e.who] : [])));
const attacked = (events: EngineEvent[]) => events.find((e) => e.type === "damage" || e.type === "attack_missed");
const attackTarget = (events: EngineEvent[]): string | undefined => {
  const e = attacked(events);
  return e && (e.type === "damage" || e.type === "attack_missed") ? e.target : undefined;
};

describe("area abilities aim for the most foes", () => {
  const blast = (affects: "enemies" | "all", target: Ability["target"]) =>
    ab("Cinder Burst", target, 6, [{ type: "damage", shape: "burst", radius_tiles: 1, dice: "1d6", damage_type: "fire", save, on_save: "half", affects }]);

  it("aims at the cluster rather than the nearest foe", () => {
    const f = scene(
      [{ enemy: foe("Bomber", ["Hurls fire"], "standard", [blast("enemies", "tile")]), at: [4, 10] }],
      { ch_brindle: [8, 10], ch_tamsin: [10, 5], ch_orrin: [10, 6] },
    );
    const r = turn(f.state, f.rng, f.ids[0]!);
    expect(used(r.events)).toHaveLength(1);
    expect(saved(r.events)).toEqual(new Set(["ch_tamsin", "ch_orrin"]));
  });
  it("an enemy-target burst picks the foe whose surroundings hold the most foes", () => {
    const f = scene(
      [{ enemy: foe("Bomber", ["Hurls fire"], "standard", [blast("enemies", "enemy")]), at: [4, 10] }],
      { ch_brindle: [8, 10], ch_tamsin: [10, 5], ch_orrin: [10, 6] },
    );
    const r = turn(f.state, f.rng, f.ids[0]!);
    const u = used(r.events)[0];
    expect(u && u.type === "ability_used" ? u.target : "").toMatch(/ch_(tamsin|orrin)/);
    expect(saved(r.events).size).toBe(2);
  });
  it("ties go to the normal foe ranking (nearest first)", () => {
    const f = scene(
      [{ enemy: foe("Bomber", ["Hurls fire"], "standard", [blast("enemies", "enemy")]), at: [4, 10] }],
      { ch_brindle: [8, 10], ch_tamsin: [10, 3], ch_orrin: [10, 16] },
    );
    const r = turn(f.state, f.rng, f.ids[0]!);
    const u = used(r.events)[0];
    expect(u && u.type === "ability_used" ? u.target : "").toBe("ch_brindle");
  });
  it("never fires a friendly-fire burst that would catch at least as many allies as foes", () => {
    const mates: FoeSpec[] = [
      { enemy: foe("Bomber", ["Hurls fire"], "standard", [blast("all", "enemy")]), at: [4, 10] },
      { enemy: foe("Mate", ["Waits"]), at: [7, 10] },
      { enemy: foe("Mate", ["Waits"]), at: [7, 11] },
    ];
    const f = scene(mates, { ch_brindle: [8, 10] });
    const r = turn(f.state, f.rng, f.ids[0]!);
    expect(used(r.events)).toHaveLength(0);
  });
  it("a friendly-fire tile burst finds a tile that spares the allies", () => {
    const mates: FoeSpec[] = [
      { enemy: foe("Bomber", ["Hurls fire"], "standard", [blast("all", "tile")]), at: [4, 10] },
      { enemy: foe("Mate", ["Waits"]), at: [7, 10] },
      { enemy: foe("Mate", ["Waits"]), at: [7, 11] },
    ];
    const f = scene(mates, { ch_brindle: [8, 10] });
    const r = turn(f.state, f.rng, f.ids[0]!);
    expect(used(r.events)).toHaveLength(1);
    const hit = saved(r.events);
    expect(hit.has("ch_brindle")).toBe(true);
    expect(hit.has(f.ids[1]!)).toBe(false);
    expect(hit.has(f.ids[2]!)).toBe(false);
  });
  it("an enemies-only burst is not held back by allies standing in it", () => {
    const mates: FoeSpec[] = [
      { enemy: foe("Bomber", ["Hurls fire"], "standard", [blast("enemies", "enemy")]), at: [4, 10] },
      { enemy: foe("Mate", ["Waits"]), at: [7, 10] },
      { enemy: foe("Mate", ["Waits"]), at: [7, 11] },
    ];
    const f = scene(mates, { ch_brindle: [8, 10] });
    const r = turn(f.state, f.rng, f.ids[0]!);
    expect(used(r.events)).toHaveLength(1);
  });
});

describe("support abilities", () => {
  const ward = ab("Ward", "ally", 4, [{ type: "shield", absorb: 4, duration_turns: 2 }]);
  const mend = ab("Mend", "ally", 4, [{ type: "heal", shape: "single", dice: "2d4" }]);

  it("shields the leader first, then the most hurt ally lacking the effect", () => {
    const f = scene(
      [
        { enemy: foe("Warder", ["Waits"], "standard", [ward]), at: [4, 10] },
        { enemy: foe("Warden", ["Waits"], "boss"), at: [6, 10] },
        { enemy: foe("Grunt", ["Waits"], "minion"), at: [5, 11], hp: 3 },
      ],
      {},
    );
    const r = turn(f.state, f.rng, f.ids[0]!);
    const sh = r.events.filter((e) => e.type === "shield");
    expect(sh).toHaveLength(1);
    expect(sh[0]).toMatchObject({ target: f.ids[1] });
    const again = turn(r.state, f.rng, f.ids[0]!, (s) => { s.entities[f.ids[0]!]!.cooldowns = {}; });
    expect(again.events.find((e) => e.type === "shield")).toMatchObject({ target: f.ids[2] });
  });
  it("does not cast on an ally that already has the effect, and skips allies out of reach", () => {
    const f = scene(
      [
        { enemy: foe("Warder", ["Waits"], "standard", [ward]), at: [4, 10] },
        { enemy: foe("Warden", ["Waits"], "boss"), at: [14, 10] },
      ],
      {},
    );
    const r = turn(f.state, f.rng, f.ids[0]!);
    // the boss is out of range; the warder shields itself (target ally includes the caster)
    const sh = r.events.filter((e) => e.type === "shield");
    expect(sh.every((e) => e.type === "shield" && e.target === f.ids[0])).toBe(true);
    const twice = turn(r.state, f.rng, f.ids[0]!, (s) => { s.entities[f.ids[0]!]!.cooldowns = {}; });
    expect(twice.events.filter((e) => e.type === "shield")).toHaveLength(0);
  });
  it("heals a hurt ally in reach even when the most hurt one is out of range", () => {
    const f = scene(
      [
        { enemy: foe("Medic", ["Waits"], "standard", [mend]), at: [4, 10] },
        { enemy: foe("Far", ["Waits"], "minion"), at: [14, 10], hp: 1 },
        { enemy: foe("Near", ["Waits"], "minion"), at: [6, 10], hp: 2 },
      ],
      {},
    );
    const r = turn(f.state, f.rng, f.ids[0]!);
    expect(r.events.find((e) => e.type === "heal")).toMatchObject({ target: f.ids[2] });
  });
  it("a tile-target heal lands on an ally in need", () => {
    const f = scene(
      [
        { enemy: foe("Medic", ["Waits"], "standard", [ab("Mist", "tile", 5, [{ type: "heal", shape: "single", dice: "2d4" }])]), at: [4, 10] },
        { enemy: foe("Near", ["Waits"], "minion"), at: [7, 10], hp: 2 },
      ],
      {},
    );
    const r = turn(f.state, f.rng, f.ids[0]!);
    expect(r.events.find((e) => e.type === "heal")).toMatchObject({ target: f.ids[1] });
  });
  it("an area heal is centred where it reaches the most hurt allies", () => {
    const f = scene(
      [
        { enemy: foe("Medic", ["Waits"], "standard", [ab("Mist", "tile", 6, [{ type: "heal", shape: "burst", radius_tiles: 1, dice: "1d6" }])]), at: [4, 10] },
        { enemy: foe("B", ["Waits"], "minion"), at: [10, 12], hp: 2 },
        { enemy: foe("C", ["Waits"], "minion"), at: [10, 14], hp: 2 },
      ],
      {},
    );
    const r = turn(f.state, f.rng, f.ids[0]!);
    const healed = new Set(r.events.flatMap((e) => (e.type === "heal" ? [e.target] : [])));
    expect(healed).toEqual(new Set([f.ids[1], f.ids[2]]));
  });
});

describe("ranged creatures keep their distance", () => {
  const archer = () => foe("Archer", ["Shoots from afar", "Keeps its distance"]);

  it("steps out of melee and still shoots", () => {
    const f = scene([{ enemy: archer(), at: [10, 10] }], { ch_brindle: [9, 10] });
    const r = turn(f.state, f.rng, f.ids[0]!);
    const e = r.state.entities[f.ids[0]!]!;
    for (const id of PARTY_IDS) expect(dist(e, r.state.entities[id]!)).toBeGreaterThan(1);
    expect(dist(e, r.state.entities.ch_brindle!)).toBeLessThanOrEqual(6);
    expect(attackTarget(r.events)).toBe("ch_brindle");
    expect(r.events.some((x) => x.type === "moved")).toBe(true);
  });
  it("shoots from where it stands when it cannot get free", () => {
    const walls: [number, number][] = [[10, 9], [11, 9], [11, 10], [11, 11], [10, 11], [9, 9], [9, 11]];
    const f = scene([{ enemy: archer(), at: [10, 10] }], { ch_brindle: [9, 10] }, { walls });
    const r = turn(f.state, f.rng, f.ids[0]!);
    const e = r.state.entities[f.ids[0]!]!;
    expect({ x: e.x, y: e.y }).toEqual({ x: 10, y: 10 });
    expect(attackTarget(r.events)).toBe("ch_brindle");
  });
  it("a melee creature stays put and fights", () => {
    const f = scene([{ enemy: foe("Brute", ["Closes to melee"]), at: [10, 10] }], { ch_brindle: [9, 10] });
    const r = turn(f.state, f.rng, f.ids[0]!);
    const e = r.state.entities[f.ids[0]!]!;
    expect({ x: e.x, y: e.y }).toEqual({ x: 10, y: 10 });
  });
  it("does not kite when rooted", () => {
    const f = scene([{ enemy: archer(), at: [10, 10] }], { ch_brindle: [9, 10] });
    const r = turn(f.state, f.rng, f.ids[0]!, (s) => { s.entities[f.ids[0]!]!.conditions.push({ condition: "rooted", turns: 2 }); s.combat!.turn.movementLeft = 0; });
    const e = r.state.entities[f.ids[0]!]!;
    expect({ x: e.x, y: e.y }).toEqual({ x: 10, y: 10 });
  });
});

describe("finishing blows", () => {
  it("a ranged creature takes a foe it can drop over a nearer one", () => {
    const f = scene(
      [{ enemy: foe("Archer", ["Shoots from afar"]), at: [10, 10] }],
      { ch_brindle: [10, 15, 3, 30], ch_tamsin: [10, 13, 20, 20], ch_orrin: [1, 1] },
    );
    const r = turn(f.state, f.rng, f.ids[0]!);
    expect(attackTarget(r.events)).toBe("ch_brindle");
  });
  it("a melee creature walks toward the foe it can finish", () => {
    const f = scene(
      [{ enemy: foe("Brute", ["Closes to melee"]), at: [10, 10] }],
      { ch_brindle: [10, 15, 3, 30], ch_tamsin: [10, 14, 20, 20], ch_orrin: [1, 1] },
    );
    // tamsin is nearer and would be the default; brindle (3 HP, average hit 3.5) is the finish
    const r = turn(f.state, f.rng, f.ids[0]!);
    expect(dist(r.state.entities[f.ids[0]!]!, r.state.entities.ch_brindle!)).toBeLessThanOrEqual(1);
  });
  it("a foe with a shield is not a finish", () => {
    const f = scene(
      [{ enemy: foe("Archer", ["Shoots from afar"]), at: [10, 10] }],
      { ch_brindle: [10, 15, 3, 30], ch_tamsin: [10, 13, 20, 20], ch_orrin: [1, 1] },
    );
    const r = turn(f.state, f.rng, f.ids[0]!, (s) => { s.entities.ch_brindle!.shield = 4; });
    expect(attackTarget(r.events)).toBe("ch_tamsin");
  });
  it("explicit tactics outrank finishing", () => {
    const f = scene(
      [{ enemy: foe("Hunter", ["Shoots from afar", "Goes for healers"]), at: [10, 10] }],
      { ch_brindle: [10, 15, 3, 30], ch_tamsin: [10, 13, 20, 20], ch_orrin: [10, 14, 11, 11] },
    );
    const r = turn(f.state, f.rng, f.ids[0]!);
    expect(attackTarget(r.events)).toBe("ch_orrin");
  });
  it("a foe out of reach is not preferred", () => {
    const f = scene(
      [{ enemy: foe("Brute", ["Closes to melee"]), at: [1, 10] }],
      { ch_brindle: [18, 18, 3, 30], ch_tamsin: [5, 10, 20, 20], ch_orrin: [1, 1] },
    );
    const r = turn(f.state, f.rng, f.ids[0]!);
    expect(dist(r.state.entities[f.ids[0]!]!, r.state.entities.ch_tamsin!)).toBeLessThanOrEqual(1);
  });
});

describe("hazard-aware movement", () => {
  const column = (x: number, from: number, to: number): [number, number][] => {
    const out: [number, number][] = [];
    for (let y = from; y <= to; y++) out.push([x, y]);
    return out;
  };
  const onFire = (s: GameState, id: string) => s.terrain.some((t) => t.kind === "fire" && t.x === s.entities[id]!.x && t.y === s.entities[id]!.y);
  const burned = (events: EngineEvent[]) => events.some((e) => e.type === "damage" && e.damageType === "fire");

  it("walks around a short line of fire instead of through it", () => {
    const f = scene([{ enemy: foe("Brute", ["Closes to melee"]), at: [4, 10] }], { ch_brindle: [10, 10] }, { terrain: column(6, 9, 11) });
    const r = turn(f.state, f.rng, f.ids[0]!);
    expect(burned(r.events)).toBe(false);
    expect(dist(r.state.entities[f.ids[0]!]!, r.state.entities.ch_brindle!)).toBeLessThanOrEqual(1);
  });
  it("crosses fire when every way around is too long, but never stops on it", () => {
    const brute = { ...foe("Brute", ["Closes to melee"]), stats: { ...chorister.stats, hp: 40, speed: 6 } };
    const f = scene([{ enemy: brute, at: [4, 10] }], { ch_brindle: [9, 10] }, { terrain: column(6, 0, 19) });
    const r = turn(f.state, f.rng, f.ids[0]!);
    expect(onFire(r.state, f.ids[0]!)).toBe(false);
  });
  it("does not end its move on a fire tile next to its target", () => {
    const f = scene([{ enemy: foe("Brute", ["Closes to melee"]), at: [4, 10] }], { ch_brindle: [7, 10] }, { terrain: [[6, 9], [6, 10], [6, 11]] });
    const r = turn(f.state, f.rng, f.ids[0]!);
    expect(onFire(r.state, f.ids[0]!)).toBe(false);
    expect(burned(r.events)).toBe(false);
  });
  it("a kiting archer does not step onto fire", () => {
    const around: [number, number][] = [];
    for (let x = 6; x <= 14; x++) for (let y = 6; y <= 14; y++) if (dist({ x, y }, { x: 10, y: 10 }) === 2) around.push([x, y]);
    const f = scene([{ enemy: foe("Archer", ["Shoots from afar"]), at: [10, 10] }], { ch_brindle: [9, 10] }, { terrain: around });
    const r = turn(f.state, f.rng, f.ids[0]!);
    expect(onFire(r.state, f.ids[0]!)).toBe(false);
    expect(attackTarget(r.events)).toBe("ch_brindle");
  });
  it("a broken creature runs around fire rather than through it", () => {
    const f = scene([{ enemy: foe("Grunt", ["Closes to melee"], "minion"), at: [10, 10] }], { ch_brindle: [9, 10] }, { terrain: column(12, 0, 19) });
    const r = turn(f.state, f.rng, f.ids[0]!, (s) => { s.entities[f.ids[0]!]!.morale = "broken"; });
    expect(burned(r.events)).toBe(false);
    expect(onFire(r.state, f.ids[0]!)).toBe(false);
  });
  it("a broken creature with no other way out may run through fire", () => {
    const walls: [number, number][] = [[9, 9], [10, 9], [11, 9], [9, 10], [9, 11], [10, 11], [11, 11]];
    const f = scene([{ enemy: foe("Grunt", ["Closes to melee"], "minion"), at: [10, 10] }], { ch_brindle: [8, 10] }, { walls, terrain: [[11, 10]] });
    const r = turn(f.state, f.rng, f.ids[0]!, (s) => { s.entities[f.ids[0]!]!.morale = "broken"; });
    expect(r.events.some((e) => e.type === "moved")).toBe(true);
  });
  it("is deterministic for a seed", () => {
    const run = () => {
      const f = scene([{ enemy: foe("Archer", ["Shoots from afar"]), at: [10, 10] }], { ch_brindle: [9, 10] });
      return turn(f.state, f.rng, f.ids[0]!).events;
    };
    expect(run()).toEqual(run());
  });
});
