import { describe, expect, it } from "vitest";
import type { Enemy } from "@aedm/schemas";
import { combatOutcome, endCombat, enemyTakeTurn, startCombat, type ActionResult } from "./combat.ts";
import type { EngineEvent } from "./events.ts";
import { applyDamage, enemyTactics, isRangedAttacker } from "./mutate.ts";
import type { Rng } from "./rng.ts";
import { cloneState, type GameState } from "./state.ts";
import { chorister, makeWorld, PARTY_IDS, spawn, withArchetype } from "./testkit.ts";

type At = [number, number];
interface FoeSpec { enemy: Enemy; at: At; hp?: number }
type PcSpec = Partial<Record<"ch_brindle" | "ch_tamsin" | "ch_orrin", [number, number, number?, number?]>>;

/** An enemy with no abilities (basic attacks only) and the given role and behavior lines. */
const foe = (name: string, behavior: string[], role: Enemy["role"] = "standard", speed = 6): Enemy => ({
  ...chorister, name, role, behavior, abilities: [], stats: { ...chorister.stats, hp: 20, speed },
});

const FAR: Record<string, At> = { ch_brindle: [1, 1], ch_tamsin: [1, 2], ch_orrin: [2, 1] };

/** Spawn the foes, move the party, set HP and start combat. Returns the enemy ids in spec order. */
function scene(foes: FoeSpec[], pcs: PcSpec, opts: { seed?: number; walls?: [number, number][] } = {}) {
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
  const r = startCombat(s, w.rng, [...PARTY_IDS, ...ids], "standard");
  expect(r.ok).toBe(true);
  return { state: r.state, rng: w.rng, ids };
}

/** Make `id` the active creature with a fresh turn and let it act. */
function turn(state: GameState, rng: Rng, id: string, mutate?: (s: GameState) => void): ActionResult {
  const s = cloneState(state);
  const c = s.combat!;
  c.cursor = c.order.findIndex((o) => o.entity_id === id);
  c.active_id = id;
  c.turn = { movementLeft: 6, actionUsed: false, quickUsed: false };
  mutate?.(s);
  return enemyTakeTurn(s, rng, id);
}

const attackTarget = (events: EngineEvent[]): string | undefined => {
  const e = events.find((x) => x.type === "damage" || x.type === "attack_missed");
  return e && (e.type === "damage" || e.type === "attack_missed") ? e.target : undefined;
};
const moraleRoll = (events: EngineEvent[]) => events.find((e) => e.type === "roll" && e.kind === "morale");
const has = (events: EngineEvent[], type: EngineEvent["type"]) => events.some((e) => e.type === type);
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

function tacticsFor(behavior: string[]): string[] {
  const w = makeWorld();
  const a = withArchetype(w.state, foe("Probe", behavior));
  const s = spawn(a.state, w.rng, a.id, 10, 10);
  const e = Object.values(s.entities).find((x) => x.kind === "enemy")!;
  return [...enemyTactics(s, e)].sort();
}

describe("tactics from behavior text", () => {
  it("recognises each tactic from natural phrasing", () => {
    expect(tacticsFor(["Picks off the weakest foe", "Closes in"])).toEqual(["focus_weakest"]);
    expect(tacticsFor(["Finishes off wounded prey", "Closes in"])).toEqual(["focus_weakest"]);
    expect(tacticsFor(["Goes for healers first", "Closes in"])).toEqual(["target_healer"]);
    expect(tacticsFor(["Targets support and casters", "Closes in"])).toEqual(["target_healer"]);
    expect(tacticsFor(["Guards its leader", "Closes in"])).toEqual(["protect_leader"]);
    expect(tacticsFor(["Defends its master", "Closes in"])).toEqual(["protect_leader"]);
    expect(tacticsFor(["Fights as a pack", "Flanks and surrounds"])).toEqual(["pack"]);
    expect(tacticsFor(["Fearless", "Closes in"])).toEqual(["fearless"]);
    expect(tacticsFor(["Fights to the death", "Closes in"])).toEqual(["fearless"]);
    expect(tacticsFor(["Cowardly", "Closes in"])).toEqual(["cowardly"]);
    expect(tacticsFor(["Retreats when hurt", "Closes in"])).toEqual(["cowardly"]);
  });
  it("never retreats means fearless, not cowardly", () => {
    expect(tacticsFor(["Never retreats", "Closes in"])).toEqual(["fearless"]);
    expect(tacticsFor(["Mindless, never flees", "Closes in"])).toEqual(["fearless"]);
  });
  it("gives plain behavior no tactics, and non-enemies none", () => {
    expect(tacticsFor(["Closes to melee", "Waits in ambush"])).toEqual([]);
    const w = makeWorld();
    expect(enemyTactics(w.state, w.state.entities[PARTY_IDS[0]!]!).size).toBe(0);
  });
  it("leaves ranged detection unchanged", () => {
    const w = makeWorld();
    const a = withArchetype(w.state, foe("Archer", ["Shoots from afar", "Keeps its distance"]));
    const s = spawn(a.state, w.rng, a.id, 10, 10);
    expect(isRangedAttacker(s, Object.values(s.entities).find((x) => x.kind === "enemy")!)).toBe(true);
  });
});

describe("target choice", () => {
  const ring: PcSpec = { ch_brindle: [9, 10, 3, 30], ch_tamsin: [11, 10, 2, 2], ch_orrin: [10, 11, 11, 11] };

  it("default order is unchanged: the lowest HP among equally near foes", () => {
    const f = scene([{ enemy: foe("Plain", ["Closes to melee", "Waits"]), at: [10, 10] }], ring);
    expect(attackTarget(turn(f.state, f.rng, f.ids[0]!).events)).toBe("ch_tamsin");
  });
  it("focus_weakest takes the lowest HP fraction in reach", () => {
    const f = scene([{ enemy: foe("Stalker", ["Picks off the weakest", "Waits"]), at: [10, 10] }], ring);
    expect(attackTarget(turn(f.state, f.rng, f.ids[0]!).events)).toBe("ch_brindle");
  });
  it("target_healer takes the foe with a healing ability", () => {
    const f = scene([{ enemy: foe("Hunter", ["Goes for healers", "Waits"]), at: [10, 10] }], ring);
    expect(attackTarget(turn(f.state, f.rng, f.ids[0]!).events)).toBe("ch_orrin");
  });
  it("protect_leader attacks the foe threatening the leader", () => {
    const f = scene(
      [{ enemy: foe("Warden", ["Waits", "Waits"], "boss"), at: [8, 10] }, { enemy: foe("Hound", ["Guards its leader", "Waits"]), at: [10, 11] }],
      { ch_brindle: [11, 12, 3, 30], ch_tamsin: [9, 12, 20, 20] },
    );
    expect(attackTarget(turn(f.state, f.rng, f.ids[1]!).events)).toBe("ch_tamsin");
  });
  it("protect_leader moves toward the leader when no foe is in reach", () => {
    const f = scene(
      [{ enemy: foe("Warden", ["Waits", "Waits"], "boss"), at: [16, 17] }, { enemy: foe("Hound", ["Guards its leader", "Waits"]), at: [10, 17] }],
      {},
    );
    const r = turn(f.state, f.rng, f.ids[1]!);
    expect(dist(r.state.entities[f.ids[1]!]!, r.state.entities[f.ids[0]!]!)).toBeLessThanOrEqual(2);
  });
  it("pack takes the foe already surrounded by its allies", () => {
    const f = scene(
      [{ enemy: foe("Wolf", ["Fights as a pack", "Waits"]), at: [10, 10] }, { enemy: foe("Wolf", ["Fights as a pack", "Waits"]), at: [12, 10] }],
      { ch_brindle: [9, 10, 3, 30], ch_tamsin: [11, 10, 20, 20] },
    );
    expect(attackTarget(turn(f.state, f.rng, f.ids[0]!).events)).toBe("ch_tamsin");
  });
});

describe("morale", () => {
  const minion = (behavior = ["Closes to melee", "Waits"]) => foe("Grunt", behavior, "minion");
  const hurtGrunt = (seed: number, behavior?: string[], role: Enemy["role"] = "minion") =>
    scene([{ enemy: foe("Grunt", behavior ?? ["Closes to melee", "Waits"], role), at: [10, 10], hp: 4 }], { ch_brindle: [9, 10] }, { seed });
  const brokenState = (state: GameState, id: string) => { const s = cloneState(state); s.entities[id]!.morale = "broken"; return s; };

  /** First seed whose morale roll holds (or fails). */
  function withRoll(held: boolean) {
    for (let seed = 1; seed < 300; seed++) {
      const f = hurtGrunt(seed);
      const r = turn(f.state, f.rng, f.ids[0]!);
      const roll = moraleRoll(r.events);
      if (roll && roll.type === "roll" && (roll.outcome === "success") === held) return { f, r };
    }
    throw new Error("no seed found");
  }

  it("a hurt minion that fails the check breaks and does not attack", () => {
    const { f, r } = withRoll(false);
    expect(has(r.events, "morale_broken")).toBe(true);
    expect(r.events.find((e) => e.type === "morale_broken")).toMatchObject({ reason: "hurt" });
    expect(r.state.entities[f.ids[0]!]?.morale ?? "gone").not.toBe("held");
    expect(attackTarget(r.events)).toBeUndefined();
  });
  it("one that passes holds and is never tested again this fight", () => {
    const { f, r } = withRoll(true);
    expect(r.state.entities[f.ids[0]!]!.morale).toBe("held");
    const again = turn(r.state, f.rng, f.ids[0]!);
    expect(moraleRoll(again.events)).toBeUndefined();
  });
  it("an unhurt enemy is not tested", () => {
    const f = scene([{ enemy: minion(), at: [10, 10] }], { ch_brindle: [9, 10] });
    expect(moraleRoll(turn(f.state, f.rng, f.ids[0]!).events)).toBeUndefined();
  });
  it("fearless and boss enemies never break", () => {
    for (let seed = 1; seed < 40; seed++) {
      for (const f of [hurtGrunt(seed, ["Fights to the death", "Waits"]), hurtGrunt(seed, ["Waits", "Waits"], "boss")]) {
        const r = turn(f.state, f.rng, f.ids[0]!);
        expect(moraleRoll(r.events)).toBeUndefined();
        expect(has(r.events, "morale_broken")).toBe(false);
      }
    }
  });
  it("cowardly enemies test sooner", () => {
    const test = (behavior: string[]) => {
      const f = scene([{ enemy: foe("Grunt", behavior, "standard"), at: [10, 10], hp: 6 }], { ch_brindle: [9, 10] });
      return moraleRoll(turn(f.state, f.rng, f.ids[0]!).events) !== undefined;
    };
    expect(test(["Closes to melee", "Waits"])).toBe(false); // 6 of 20 is 30%, not below 30%
    expect(test(["Cowardly", "Waits"])).toBe(true); // 30% + 20% threshold
  });
  it("minions break when the last leader falls", () => {
    const f = scene(
      [{ enemy: foe("Warden", ["Waits", "Waits"], "boss"), at: [10, 10], hp: 1 }, { enemy: minion(), at: [12, 10] }],
      { ch_brindle: [11, 10] },
    );
    const m = { s: cloneState(f.state), rng: f.rng, ev: [] as EngineEvent[] };
    applyDamage(m, m.s.entities[f.ids[0]!]!, 5);
    expect(m.s.entities[f.ids[1]!]!.morale).toBe("broken");
    expect(m.ev.find((e) => e.type === "morale_broken")).toMatchObject({ entityId: f.ids[1], reason: "leader_down" });
  });
  it("a boss or elite is reported bloodied once", () => {
    const f = scene([{ enemy: foe("Warden", ["Waits", "Waits"], "elite"), at: [10, 10] }], { ch_brindle: [9, 10] });
    const m = { s: cloneState(f.state), rng: f.rng, ev: [] as EngineEvent[] };
    const e = m.s.entities[f.ids[0]!]!;
    applyDamage(m, e, 5);
    expect(has(m.ev, "bloodied")).toBe(false);
    applyDamage(m, e, 6);
    applyDamage(m, e, 2);
    expect(m.ev.filter((x) => x.type === "bloodied")).toHaveLength(1);
  });
  it("a broken enemy runs away from its foes", () => {
    const f = scene([{ enemy: minion(), at: [10, 10] }], { ch_brindle: [9, 10] });
    const r = turn(brokenState(f.state, f.ids[0]!), f.rng, f.ids[0]!);
    const e = r.state.entities[f.ids[0]!]!;
    expect(dist(e, r.state.entities.ch_brindle!)).toBeGreaterThan(1);
    expect(attackTarget(r.events)).toBeUndefined();
  });
  it("flees at the map edge: removed from the order and the map, turns stay valid, the fight is won", () => {
    const f = scene([{ enemy: minion(), at: [17, 10] }], { ch_brindle: [12, 10] });
    const r = turn(brokenState(f.state, f.ids[0]!), f.rng, f.ids[0]!);
    expect(has(r.events, "fled")).toBe(true);
    expect(r.state.entities[f.ids[0]!]).toBeUndefined();
    const c = r.state.combat!;
    expect(c.order.some((o) => o.entity_id === f.ids[0])).toBe(false);
    expect(c.order[c.cursor]!.entity_id).toBe(c.active_id);
    expect(combatOutcome(r.state)).toBe("victory");
    expect(has(r.events, "enemies_cleared")).toBe(true);
  });
  it("flees once every foe is far enough away", () => {
    const f = scene([{ enemy: minion(), at: [8, 10] }], { ch_brindle: [1, 10] });
    const r = turn(brokenState(f.state, f.ids[0]!), f.rng, f.ids[0]!);
    expect(has(r.events, "fled")).toBe(true);
  });
  it("a cornered enemy surrenders and becomes a wary NPC the DM can talk to", () => {
    const walls: [number, number][] = [[9, 9], [10, 9], [11, 9], [9, 10], [11, 10], [9, 11], [10, 11], [11, 11]];
    const f = scene([{ enemy: minion(), at: [10, 10] }], { ch_brindle: [13, 10] }, { walls });
    const id = f.ids[0]!;
    const r = turn(brokenState(f.state, id), f.rng, id);
    expect(r.events.find((e) => e.type === "surrendered")).toMatchObject({ entityId: id, name: "Grunt" });
    const e = r.state.entities[id]!;
    expect(e).toMatchObject({ kind: "npc", disposition: "wary", refId: id });
    expect(r.state.npcs[id]).toMatchObject({ id, name: "Grunt", role: "bystander", map_id: "m_lighthouse", x: 10, y: 10, disposition: "wary", alive: true, last_seen_beat: r.state.turn });
    const c = r.state.combat!;
    expect(c.order.some((o) => o.entity_id === id)).toBe(false);
    expect(c.order[c.cursor]!.entity_id).toBe(c.active_id);
    expect(combatOutcome(r.state)).toBe("victory");
  });
  it("clears morale and bloodied when combat ends", () => {
    const f = scene([{ enemy: minion(), at: [10, 10] }], { ch_brindle: [9, 10] });
    const s = brokenState(f.state, f.ids[0]!);
    s.entities[f.ids[0]!]!.bloodied = true;
    const e = endCombat(s, f.rng, "truce").state.entities[f.ids[0]!]!;
    expect(e.morale).toBeUndefined();
    expect(e.bloodied).toBeUndefined();
  });
  it("is deterministic for a seed", () => {
    const run = () => {
      const f = hurtGrunt(5);
      const r = turn(f.state, f.rng, f.ids[0]!);
      return JSON.stringify([r.events, r.state.rngState, Object.values(r.state.entities).map((e) => [e.id, e.x, e.y, e.morale])]);
    };
    expect(run()).toBe(run());
  });
});
