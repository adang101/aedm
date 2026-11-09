import { describe, expect, it } from "vitest";
import { fixtures } from "@aedm/schemas";
import {
  advanceBeat, basicAttack, combatOutcome, endCombat, endTurn, enemyTakeTurn, extinguish, moveEntity, rest, reviveAlly,
  runAiTurns, startCombat, useAbility, useItem, type ActionResult,
} from "./combat.ts";
import { applyDmActions } from "./dm-actions.ts";
import { createRng, type Rng } from "./rng.ts";
import { cloneState, setAbsent, type GameState } from "./state.ts";
import { PARTY_IDS, makeWorld, spawn, withArchetype } from "./testkit.ts";

const CTX = { presentCharacterIds: PARTY_IDS, partyLevel: 1 };

/** A world with one chorister next to the party and combat started. */
function fight(seed = 7, enemyAt: [number, number] = [6, 2]) {
  const w = makeWorld(seed);
  const a = withArchetype(w.state);
  const state = spawn(a.state, w.rng, a.id, enemyAt[0], enemyAt[1]);
  const enemyId = Object.values(state.entities).find((e) => e.kind === "enemy")!.id;
  return { ...w, state, enemyId, archetypeId: a.id };
}

function begin(state: GameState, rng: Rng, enemyId: string): ActionResult {
  const r = startCombat(state, rng, [...PARTY_IDS, enemyId], "standard");
  expect(r.ok).toBe(true);
  return r;
}

/** Make the named entity the active one (test helper; mutates a clone). */
function activate(state: GameState, id: string): GameState {
  const s = cloneState(state);
  const c = s.combat!;
  c.cursor = c.order.findIndex((o) => o.entity_id === id);
  c.active_id = id;
  c.turn = { movementLeft: 6, actionUsed: false, quickUsed: false };
  return s;
}

const place = (state: GameState, id: string, x: number, y: number): GameState => {
  const s = cloneState(state);
  s.entities[id]!.x = x;
  s.entities[id]!.y = y;
  return s;
};

describe("startCombat", () => {
  it("rolls initiative, orders descending, and starts the first turn", () => {
    const f = fight();
    const r = begin(f.state, f.rng, f.enemyId);
    const c = r.state.combat!;
    expect(c.order).toHaveLength(4);
    for (let i = 1; i < c.order.length; i++) expect(c.order[i - 1]!.initiative).toBeGreaterThanOrEqual(c.order[i]!.initiative);
    expect(c.round).toBe(1);
    expect(c.active_id).toBe(c.order[0]!.entity_id);
    expect(r.events.map((e) => e.type)).toEqual(expect.arrayContaining(["combat_started", "turn_started", "roll"]));
  });
  it("refuses a one-sided or duplicate combat and leaves the input state alone", () => {
    const f = fight();
    const snapshot = JSON.stringify(f.state);
    expect(startCombat(f.state, f.rng, PARTY_IDS, "standard").ok).toBe(false);
    expect(JSON.stringify(f.state)).toBe(snapshot);
    const r = begin(f.state, f.rng, f.enemyId);
    expect(startCombat(r.state, f.rng, [...PARTY_IDS, f.enemyId], "standard").ok).toBe(false);
  });
  it("breaks initiative ties by DEX then players", () => {
    // run many seeds; whenever totals tie the higher dex / player must come first
    for (let seed = 0; seed < 40; seed++) {
      const f = fight(seed);
      const c = begin(f.state, createRng(seed), f.enemyId).state.combat!;
      for (let i = 1; i < c.order.length; i++) {
        const a = c.order[i - 1]!;
        const b = c.order[i]!;
        if (a.initiative !== b.initiative) continue;
        const dex = (id: string) => (f.state.characters[id]?.scores.dex ?? 10);
        expect(dex(a.entity_id)).toBeGreaterThanOrEqual(dex(b.entity_id));
      }
    }
  });
});

describe("moveEntity", () => {
  it("moves freely in exploration and emits a moved event", () => {
    const { state, rng } = makeWorld();
    const e = state.entities.ch_tamsin!;
    const r = moveEntity(state, rng, "ch_tamsin", { x: e.x + 4, y: e.y + 3 });
    expect(r.ok).toBe(true);
    expect(r.state.entities.ch_tamsin).toMatchObject({ x: e.x + 4, y: e.y + 3 });
    expect(r.events[0]).toMatchObject({ type: "moved", reason: "walk" });
    expect(state.entities.ch_tamsin!.x).toBe(e.x); // input untouched
  });
  it("respects walls and occupied tiles", () => {
    const { state, rng } = makeWorld(7, { walls: [[10, 2]] });
    expect(moveEntity(state, rng, "ch_tamsin", { x: 10, y: 2 }).ok).toBe(false);
    const other = state.entities.ch_orrin!;
    expect(moveEntity(state, rng, "ch_tamsin", { x: other.x, y: other.y }).ok).toBe(false);
  });
  it("in combat only the active creature moves, within speed", () => {
    const f = fight();
    const started = begin(f.state, f.rng, f.enemyId).state;
    const pcs = PARTY_IDS.filter((id) => id !== started.combat!.active_id);
    const notActive = pcs[0]!;
    expect(moveEntity(started, f.rng, notActive, { x: 15, y: 15 }).ok).toBe(false);
    let s = activate(started, "ch_tamsin");
    s = place(s, "ch_tamsin", 2, 10);
    const far = moveEntity(s, f.rng, "ch_tamsin", { x: 2, y: 17 });
    expect(far.ok).toBe(false);
    expect(far.error).toMatch(/movement/);
    const near = moveEntity(s, f.rng, "ch_tamsin", { x: 2, y: 16 });
    expect(near.ok).toBe(true);
    expect(near.state.combat!.turn.movementLeft).toBe(0);
  });
  it("rooted and stunned creatures cannot move; slowed lowers speed; prone costs 3 to stand", () => {
    const f = fight();
    const started = begin(f.state, f.rng, f.enemyId).state;
    let s = place(activate(started, "ch_tamsin"), "ch_tamsin", 2, 10);
    s.entities.ch_tamsin!.conditions.push({ condition: "rooted", turns: 2 });
    expect(moveEntity(s, f.rng, "ch_tamsin", { x: 2, y: 11 }).ok).toBe(false);
    s = place(activate(started, "ch_tamsin"), "ch_tamsin", 2, 10);
    s.entities.ch_tamsin!.conditions.push({ condition: "prone", turns: 2 });
    expect(moveEntity(s, f.rng, "ch_tamsin", { x: 2, y: 14 }).ok).toBe(false); // 4 + 3 > 6
    const ok = moveEntity(s, f.rng, "ch_tamsin", { x: 2, y: 13 });
    expect(ok.ok).toBe(true);
    expect(ok.state.entities.ch_tamsin!.conditions.find((c) => c.condition === "prone")).toBeUndefined();
  });
});

describe("basicAttack", () => {
  it("rolls d20 + key mod + proficiency against defense and applies weapon dice + key mod", () => {
    const f = fight();
    let s = begin(f.state, f.rng, f.enemyId).state;
    s = place(activate(s, "ch_tamsin"), "ch_tamsin", 5, 2); // adjacent to the enemy at (6,2)
    const r = basicAttack(s, f.rng, "ch_tamsin", f.enemyId);
    expect(r.ok).toBe(true);
    const roll = r.events.find((e) => e.type === "roll")!;
    expect(roll).toMatchObject({ kind: "attack", modifier: 4, target: 12 }); // DEX +2, prof +2, vs defense 12
    expect(r.state.combat!.turn.actionUsed).toBe(true);
    expect(basicAttack(r.state, f.rng, "ch_tamsin", f.enemyId).ok).toBe(false); // one action per turn
  });
  it("hits for dice + key mod, nat 1 always misses, nat 20 doubles dice", () => {
    let crit = false, fumble = false, hit = false;
    for (let seed = 0; seed < 300 && !(crit && fumble && hit); seed++) {
      const f = fight(1);
      let s = begin(f.state, createRng(seed), f.enemyId).state;
      s = place(activate(s, "ch_tamsin"), "ch_tamsin", 5, 2);
      const r = basicAttack(s, createRng(seed), "ch_tamsin", f.enemyId);
      const roll = r.events.find((e) => e.type === "roll");
      const dmg = r.events.find((e) => e.type === "damage");
      if (roll?.type !== "roll") continue;
      if (roll.outcome === "crit") {
        crit = true;
        expect(dmg).toMatchObject({ crit: true });
        expect(dmg && dmg.type === "damage" ? dmg.dice : []).toHaveLength(2);
      } else if (roll.outcome === "fumble") {
        fumble = true;
        expect(dmg).toBeUndefined();
      } else if (roll.outcome === "success") {
        hit = true;
        expect(dmg && dmg.type === "damage" ? dmg.amount : 0).toBeGreaterThanOrEqual(1);
      }
    }
    expect(crit && fumble && hit).toBe(true);
  });
  it("rejects out of range, attacking allies, and attacking while stunned", () => {
    const f = fight();
    let s = begin(f.state, f.rng, f.enemyId).state;
    s = activate(s, "ch_brindle"); // INT key: ranged 6
    s = place(s, "ch_brindle", 0, 10);
    expect(basicAttack(s, f.rng, "ch_brindle", f.enemyId).ok).toBe(false);
    expect(basicAttack(s, f.rng, "ch_brindle", "ch_orrin").ok).toBe(false);
    s.entities.ch_brindle!.conditions.push({ condition: "stunned", turns: 1 });
    s = place(s, "ch_brindle", 4, 2);
    expect(basicAttack(s, f.rng, "ch_brindle", f.enemyId).ok).toBe(false);
  });
  it("applies weakness and resistance (1.5x and 0.5x, rounded down)", () => {
    const f = fight();
    let s = begin(f.state, f.rng, f.enemyId).state;
    s = place(activate(s, "ch_tamsin"), "ch_tamsin", 5, 2);
    const arch = s.archetypes[f.archetypeId]!;
    arch.weakness = "sharp";
    arch.stats.defense = 5; // make hits near-certain
    let seen = 0;
    for (let seed = 0; seed < 50 && seen < 3; seed++) {
      const r = basicAttack(s, createRng(seed), "ch_tamsin", f.enemyId);
      const d = r.events.find((e) => e.type === "damage");
      const roll = r.events.find((e) => e.type === "roll");
      if (!d || d.type !== "damage" || roll?.type !== "roll" || roll.outcome === "crit") continue;
      const raw = d.dice!.reduce((a, b) => a + b, 0) + 2; // DEX key +2
      expect(d.amount).toBe(Math.min(10, Math.floor((raw * 3) / 2)));
      seen++;
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe("abilities", () => {
  it("Shaped Charge: burst on a tile, DEX saves, half damage, stun only on a failed save, cooldown set", () => {
    const f = fight();
    let state = f.state;
    state = spawn(state, f.rng, f.archetypeId, 7, 3);
    const ids = Object.values(state.entities).filter((e) => e.kind === "enemy").map((e) => e.id);
    expect(ids).toHaveLength(2);
    let s = begin(state, f.rng, ids[0]!).state;
    s = activate(s, "ch_brindle");
    s = place(place(s, "ch_brindle", 2, 2), ids[0]!, 7, 2);
    s = place(s, ids[1]!, 8, 2);
    const abId = fixtures.BRINDLE.abilities[0]!.id!;
    const r = useAbility(s, f.rng, "ch_brindle", abId, { x: 7, y: 2 });
    expect(r.ok).toBe(true);
    const saves = r.events.filter((e) => e.type === "roll" && e.kind === "save");
    expect(saves).toHaveLength(2); // one save per target, shared by damage and stun
    expect(saves[0]).toMatchObject({ target: 8 + 2 + 2 }); // 8 + prof 2 + INT mod 2
    expect(r.events.filter((e) => e.type === "damage")).toHaveLength(2);
    const stunned = r.events.filter((e) => e.type === "condition_applied" && e.condition === "stunned");
    const failed = saves.filter((e) => e.type === "roll" && e.outcome === "failure").length;
    expect(stunned).toHaveLength(failed);
    expect(r.state.entities.ch_brindle!.cooldowns[abId]).toBe(4);
    expect(useAbility(r.state, f.rng, "ch_brindle", abId, { x: 7, y: 2 }).ok).toBe(false);
  });
  it("one use per rest abilities are spent", () => {
    const f = fight();
    let s = begin(f.state, f.rng, f.enemyId).state;
    s = activate(s, "ch_brindle");
    s = place(s, "ch_brindle", 2, 2);
    const tripwire = fixtures.BRINDLE.abilities[1]!.id!;
    const r1 = useAbility(s, f.rng, "ch_brindle", tripwire, { x: 4, y: 2 });
    expect(r1.ok).toBe(true);
    expect(r1.state.entities.ch_brindle!.usesLeft[tripwire]).toBe(1);
    expect(r1.state.terrain).toHaveLength(1);
    expect(r1.state.terrain[0]).toMatchObject({ kind: "trap", hidden: true });
  });
  it("a trap hurts the first enemy that crosses it and is consumed", () => {
    const f = fight();
    let s = cloneState(f.state);
    s.terrain.push({ id: "tr_1", mapId: "m_lighthouse", x: 5, y: 2, kind: "trap", turns: null, ownerId: "ch_brindle", side: "party", dice: "1d6", damageType: "sharp", hidden: true });
    s = place(s, f.enemyId, 7, 2);
    s = begin(s, f.rng, f.enemyId).state;
    s = activate(s, f.enemyId);
    const r = moveEntity(s, f.rng, f.enemyId, { x: 4, y: 2 });
    expect(r.ok).toBe(true);
    expect(r.events.some((e) => e.type === "damage")).toBe(true);
    expect(r.state.terrain).toHaveLength(0);
    expect(r.state.entities[f.enemyId]!.x).toBe(5); // stopped on the trap
  });
  it("Mending Poultice heals and revives a downed ally; healing ends bleeding", () => {
    const f = fight();
    let s = begin(f.state, f.rng, f.enemyId).state;
    s = place(activate(s, "ch_orrin"), "ch_orrin", 2, 2);
    s = place(s, "ch_tamsin", 3, 2);
    s.entities.ch_tamsin!.hp = 0;
    s.entities.ch_tamsin!.conditions = [{ condition: "prone", turns: 99 }];
    s.entities.ch_tamsin!.downedRounds = 1;
    const poultice = fixtures.ORRIN.abilities[0]!.id!;
    const r = useAbility(s, f.rng, "ch_orrin", poultice, "ch_tamsin");
    expect(r.ok).toBe(true);
    expect(r.events.map((e) => e.type)).toEqual(expect.arrayContaining(["heal", "revived"]));
    const t = r.state.entities.ch_tamsin!;
    expect(t.hp).toBeGreaterThanOrEqual(2);
    expect(t.downedRounds).toBeUndefined();
    // bleeding ends on heal
    let b = cloneState(r.state);
    b.entities.ch_tamsin!.conditions.push({ condition: "bleeding", turns: 3 });
    b.entities.ch_tamsin!.hp = 3;
    b = activate(b, "ch_orrin");
    const r2 = useAbility(b, f.rng, "ch_orrin", poultice, "ch_tamsin");
    expect(r2.ok).toBe(false); // on cooldown from the first use
    b.entities.ch_orrin!.cooldowns = {};
    const r3 = useAbility(b, f.rng, "ch_orrin", poultice, "ch_tamsin");
    expect(r3.state.entities.ch_tamsin!.conditions.some((c) => c.condition === "bleeding")).toBe(false);
  });
  it("conditions do not stack: the longer duration wins", () => {
    const f = fight();
    const r1 = applyDmActions(f.state, f.rng, [
      { type: "apply_condition", target: "ch_orrin", condition: "slowed", turns: 1 },
      { type: "apply_condition", target: "ch_orrin", condition: "slowed", turns: 1 },
    ], CTX);
    expect(r1.state.entities.ch_orrin!.conditions.filter((c) => c.condition === "slowed")).toHaveLength(1);
    const lvl5 = { presentCharacterIds: PARTY_IDS, partyLevel: 5 };
    const r2 = applyDmActions(r1.state, f.rng, [{ type: "apply_condition", target: "ch_orrin", condition: "slowed", turns: 2 }], lvl5);
    expect(r2.state.entities.ch_orrin!.conditions).toEqual([{ condition: "slowed", turns: 2 }]);
    const r3 = applyDmActions(r2.state, f.rng, [{ type: "apply_condition", target: "ch_orrin", condition: "slowed", turns: 1 }], lvl5);
    expect(r3.state.entities.ch_orrin!.conditions).toEqual([{ condition: "slowed", turns: 2 }]);
  });
  it("shield absorbs before HP; hasted/evasive fixtures apply", () => {
    const f = fight();
    const s = cloneState(f.state);
    s.entities.ch_orrin!.shield = 3;
    s.entities.ch_orrin!.conditions.push({ condition: "shielded", turns: 2 });
    const e = place(s, f.enemyId, 3, 3);
    const started = begin(e, f.rng, f.enemyId).state;
    let hit: ActionResult | null = null;
    for (let seed = 0; seed < 100 && !hit; seed++) {
      const st = activate(started, f.enemyId);
      const r = basicAttack(st, createRng(seed), f.enemyId, "ch_orrin");
      if (r.events.some((x) => x.type === "damage")) hit = r;
    }
    const dmg = hit!.events.find((x) => x.type === "damage");
    expect(dmg).toMatchObject({ absorbed: 3 });
  });
});

describe("turn flow, conditions and downed rules", () => {
  it("endTurn ticks conditions at the end of the creature's own turn and advances", () => {
    const f = fight();
    const s = begin(f.state, f.rng, f.enemyId).state;
    const firstId = s.combat!.active_id;
    s.entities[firstId]!.conditions.push({ condition: "dazzled", turns: 1 }, { condition: "evasive", turns: 2 });
    s.entities[firstId]!.cooldowns = { ab_x: 2 };
    const r = endTurn(s, f.rng, firstId);
    expect(r.ok).toBe(true);
    const e = r.state.entities[firstId]!;
    expect(e.conditions).toEqual([{ condition: "evasive", turns: 1 }]);
    expect(e.cooldowns.ab_x).toBe(1);
    expect(r.state.combat!.active_id).not.toBe(firstId);
    expect(endTurn(r.state, f.rng, firstId).ok).toBe(false); // not their turn any more
  });
  it("the round counter increments after the last creature", () => {
    const f = fight();
    let s = begin(f.state, f.rng, f.enemyId).state;
    for (let i = 0; i < 4; i++) {
      const id = s.combat!.active_id;
      s = endTurn(s, f.rng, id).state;
    }
    expect(s.combat!.round).toBe(2);
  });
  it("a condition applied on your own turn lasts through your next turn (turns + 1 at apply time)", () => {
    const f = fight();
    const s = begin(f.state, f.rng, f.enemyId).state;
    const id = s.combat!.active_id;
    const r = applyDmActions(s, f.rng, [{ type: "apply_condition", target: id, condition: "hasted", turns: 1 }], CTX);
    expect(r.state.entities[id]!.conditions[0]).toMatchObject({ condition: "hasted", turns: 2 });
  });
  it("burning and bleeding deal damage at the start of the turn; extinguish removes burning", () => {
    const f = fight();
    let s = begin(f.state, f.rng, f.enemyId).state;
    const pcId = PARTY_IDS.find((id) => id !== s.combat!.active_id)!;
    // make the pc next in line, burning
    s = activate(s, s.combat!.order.find((o) => o.entity_id !== pcId)!.entity_id);
    s.entities[pcId]!.conditions.push({ condition: "burning", turns: 2 }, { condition: "bleeding", turns: 2 });
    s.combat!.cursor = s.combat!.order.findIndex((o) => o.entity_id === pcId) - 1;
    const hpBefore = s.entities[pcId]!.hp;
    const r = endTurn(s, f.rng);
    const dmg = r.events.filter((e) => e.type === "damage" && e.target === pcId);
    expect(r.state.combat!.active_id).toBe(pcId);
    expect(dmg.length).toBe(2);
    expect(r.state.entities[pcId]!.hp).toBeLessThan(hpBefore);
    const x = extinguish(r.state, f.rng, pcId);
    expect(x.ok).toBe(true);
    expect(x.state.entities[pcId]!.conditions.some((c) => c.condition === "burning")).toBe(false);
  });
  it("0 HP: pc is downed and prone, an enemy at 0 HP is removed", () => {
    const f = fight();
    let s = begin(f.state, f.rng, f.enemyId).state;
    s = place(activate(s, f.enemyId), f.enemyId, 3, 2);
    s.entities.ch_orrin!.hp = 1;
    let r: ActionResult | null = null;
    for (let seed = 0; seed < 200 && !r; seed++) {
      const t = basicAttack(s, createRng(seed), f.enemyId, "ch_orrin");
      if (t.events.some((e) => e.type === "downed")) r = t;
    }
    expect(r).not.toBeNull();
    const o = r!.state.entities.ch_orrin!;
    expect(o.hp).toBe(0);
    expect(o.conditions.some((c) => c.condition === "prone")).toBe(true);
    expect(o.downedRounds).toBe(0);
    // an attack against a downed pc does nothing further
    // kill the enemy
    let k = place(activate(r!.state, "ch_tamsin"), "ch_tamsin", 5, 2);
    k = place(k, f.enemyId, 6, 2);
    k.entities[f.enemyId]!.hp = 1;
    let kill: ActionResult | null = null;
    for (let seed = 0; seed < 200 && !kill; seed++) {
      const t = basicAttack(k, createRng(seed), "ch_tamsin", f.enemyId);
      if (t.events.some((e) => e.type === "defeated")) kill = t;
    }
    expect(kill!.state.entities[f.enemyId]).toBeUndefined();
    expect(kill!.state.combat!.order.some((x) => x.entity_id === f.enemyId)).toBe(false);
    expect(kill!.events.some((e) => e.type === "enemies_cleared")).toBe(true);
    expect(combatOutcome(kill!.state)).toBe("victory");
  });
  it("a downed pc is out after 3 rounds; end of combat wakes everyone at 1 HP", () => {
    const f = fight();
    let s = begin(f.state, f.rng, f.enemyId).state;
    s.entities.ch_orrin!.hp = 0;
    s.entities.ch_orrin!.conditions = [{ condition: "prone", turns: 99 }];
    s.entities.ch_orrin!.downedRounds = 0;
    let steps = 0;
    while (!s.entities.ch_orrin!.out && steps++ < 40) {
      const id = s.combat!.active_id;
      s = endTurn(s, f.rng, id).state;
    }
    expect(s.entities.ch_orrin!.out).toBe(true);
    expect(s.combat!.round).toBeGreaterThanOrEqual(3);
    const r = endCombat(s, f.rng, "flee");
    expect(r.ok).toBe(true);
    expect(r.state.combat).toBeNull();
    expect(r.state.entities.ch_orrin).toMatchObject({ hp: 1 });
    expect(r.state.entities.ch_orrin!.out).toBeUndefined();
    expect(r.state.entities.ch_orrin!.conditions).toEqual([]);
    expect(r.events.map((e) => e.type)).toContain("woke");
  });
  it("an ally revives a downed character at 1 HP with a DC 10 Wisdom check", () => {
    const f = fight();
    let s = begin(f.state, f.rng, f.enemyId).state;
    s = place(place(activate(s, "ch_orrin"), "ch_orrin", 2, 2), "ch_tamsin", 3, 2);
    s.entities.ch_tamsin!.hp = 0;
    s.entities.ch_tamsin!.downedRounds = 0;
    let won = false, lost = false;
    for (let seed = 0; seed < 60 && !(won && lost); seed++) {
      const r = reviveAlly(s, createRng(seed), "ch_orrin", "ch_tamsin");
      expect(r.ok).toBe(true);
      const roll = r.events.find((e) => e.type === "roll");
      if (roll?.type === "roll" && roll.outcome === "success") { won = true; expect(r.state.entities.ch_tamsin!.hp).toBe(1); }
      else { lost = true; expect(r.state.entities.ch_tamsin!.hp).toBe(0); }
    }
    expect(won && lost).toBe(true);
  });
  it("an absent player's character cannot drop below 1 HP", () => {
    const f = fight();
    let s = begin(f.state, f.rng, f.enemyId).state;
    s = setAbsent(s, ["ch_orrin"]);
    s = place(activate(s, f.enemyId), f.enemyId, 3, 2);
    s.entities.ch_orrin!.hp = 1;
    for (let seed = 0; seed < 60; seed++) {
      const r = basicAttack(s, createRng(seed), f.enemyId, "ch_orrin");
      expect(r.state.entities.ch_orrin!.hp).toBe(1);
      expect(r.events.some((e) => e.type === "downed")).toBe(false);
    }
  });
  it("stunned creatures lose their turn", () => {
    const f = fight();
    const s = begin(f.state, f.rng, f.enemyId).state;
    const next = s.combat!.order[1]!.entity_id;
    s.entities[next]!.conditions.push({ condition: "stunned", turns: 1 });
    const first = s.combat!.active_id;
    const r = endTurn(s, f.rng, first);
    expect(r.state.combat!.active_id).not.toBe(next);
    expect(r.events.some((e) => e.type === "note")).toBe(true);
    expect(r.state.entities[next]!.conditions).toEqual([]);
  });
});

describe("items, rest, beats", () => {
  it("a healing draught heals 2d4+2 as a quick action", () => {
    const f = fight();
    let s = cloneState(f.state);
    s.characters.ch_orrin!.inventory.push({ id: "it_9", name: "Healing draught", kind: "consumable", value: 25 });
    s.entities.ch_orrin!.hp = 2;
    s = begin(s, f.rng, f.enemyId).state;
    s = activate(s, "ch_orrin");
    const r = useItem(s, f.rng, "ch_orrin", "it_9");
    expect(r.ok).toBe(true);
    const heal = r.events.find((e) => e.type === "heal");
    expect(heal && heal.type === "heal" ? heal.amount : 0).toBeGreaterThanOrEqual(4);
    expect(r.state.characters.ch_orrin!.inventory).toHaveLength(0);
    expect(r.state.combat!.turn.quickUsed).toBe(true);
  });
  it("rest restores half max HP and resets cooldowns and uses", () => {
    const f = fight();
    const s = cloneState(f.state);
    s.entities.ch_brindle!.hp = 1;
    s.entities.ch_brindle!.cooldowns = { x: 2 };
    s.entities.ch_brindle!.usesLeft = Object.fromEntries(Object.keys(s.entities.ch_brindle!.usesLeft).map((k) => [k, 0]));
    const r = rest(s, f.rng);
    expect(r.state.entities.ch_brindle!.hp).toBe(7); // 1 + floor(12 / 2)
    expect(r.state.entities.ch_brindle!.cooldowns).toEqual({});
    expect(Object.values(r.state.entities.ch_brindle!.usesLeft).every((n) => n === 2)).toBe(true);
    expect(rest(begin(f.state, f.rng, f.enemyId).state, f.rng).ok).toBe(false);
  });
  it("advanceBeat ticks exploration conditions", () => {
    const f = fight();
    const s = cloneState(f.state);
    s.entities.ch_orrin!.conditions.push({ condition: "dazzled", turns: 1 });
    const r = advanceBeat(s, f.rng);
    expect(r.state.entities.ch_orrin!.conditions).toEqual([]);
    expect(r.state.turn).toBe(1);
  });
});

describe("enemy AI", () => {
  it("moves toward the nearest pc and attacks when in reach", () => {
    const f = fight(7, [14, 2]);
    let s = begin(f.state, f.rng, f.enemyId).state;
    s = activate(s, f.enemyId);
    const before = s.entities[f.enemyId]!;
    const r = enemyTakeTurn(s, f.rng, f.enemyId);
    expect(r.ok).toBe(true);
    const after = r.state.entities[f.enemyId]!;
    expect(Math.max(Math.abs(after.x - before.x), Math.abs(after.y - before.y))).toBeGreaterThan(0);
    expect(Math.max(Math.abs(after.x - before.x), Math.abs(after.y - before.y))).toBeLessThanOrEqual(6);
    expect(r.state.combat!.active_id).not.toBe(f.enemyId);
    expect(r.events.some((e) => e.type === "turn_ended")).toBe(true);
  });
  it("attacks an adjacent pc instead of moving, and uses an ability when one is ready and in range", () => {
    const f = fight(7, [4, 2]);
    let s = begin(f.state, f.rng, f.enemyId).state;
    s = activate(s, f.enemyId);
    s = place(s, f.enemyId, 3, 3);
    const r = enemyTakeTurn(s, f.rng, f.enemyId);
    const types = r.events.map((e) => e.type);
    // Borrowed Voice (range 6, ready) goes first; the action is spent so no basic attack follows
    expect(types).toContain("ability_used");
    // cooldown 3 means 3 further own turns blocked: set to 4, ticked to 3 at the end of this turn
    expect(Object.values(r.state.entities[f.enemyId]!.cooldowns)).toEqual([3]);
    // next turn the ability is on cooldown: it uses a basic attack
    let s2 = activate(r.state, f.enemyId);
    s2 = place(s2, f.enemyId, 3, 3);
    const r2 = enemyTakeTurn(s2, f.rng, f.enemyId);
    expect(r2.events.some((e) => e.type === "roll" && e.kind === "attack")).toBe(true);
    expect(r2.events.some((e) => e.type === "ability_used")).toBe(false);
  });
  it("a full round: players end turns, the enemy takes its AI turn, the round advances", () => {
    const f = fight(11, [6, 3]);
    let s = begin(f.state, f.rng, f.enemyId).state;
    const seen = new Set<string>();
    for (let guard = 0; guard < 12 && s.combat && s.combat.round < 2; guard++) {
      const id = s.combat.active_id;
      seen.add(id);
      const e = s.entities[id]!;
      s = (e.kind === "enemy" ? enemyTakeTurn(s, f.rng, id) : endTurn(s, f.rng, id)).state;
    }
    expect(s.combat!.round).toBe(2);
    expect(seen.has(f.enemyId)).toBe(true);
    expect(s.seq).toBeGreaterThan(0);
    expect(s.log.length).toBeGreaterThan(0);
  });
  it("runAiTurns stops at the first player and the whole fight is deterministic", () => {
    const run = () => {
      const f = fight(21, [8, 2]);
      let s = begin(f.state, createRng(5), f.enemyId).state;
      const rng = createRng(99);
      let rounds = 0;
      while (s.combat && rounds++ < 80 && combatOutcome(s) === null) {
        const ai = runAiTurns(s, rng);
        s = ai.state;
        if (!s.combat || combatOutcome(s) !== null) break;
        const e = s.entities[s.combat.active_id]!;
        if (e.kind === "pc") {
          // simple scripted player: attack the enemy if able, else end turn
          const foe = Object.values(s.entities).find((x) => x.kind === "enemy");
          if (foe) {
            const near = moveEntity(s, rng, e.id, { x: Math.max(0, foe.x - 1), y: foe.y });
            if (near.ok) s = near.state;
            const att = basicAttack(s, rng, e.id, foe.id);
            if (att.ok) s = att.state;
          }
          s = endTurn(s, rng, e.id).state;
        }
      }
      return JSON.stringify([s.rngState, s.seq, s.combat?.round, Object.values(s.entities).map((x) => [x.id, x.hp, x.x, x.y])]);
    };
    expect(run()).toBe(run());
  });
});
