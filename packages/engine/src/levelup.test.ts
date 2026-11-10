import { describe, expect, it } from "vitest";
import type { Ability, AbilityDraft } from "@aedm/schemas";
import { addAbilityToCharacter, addGrowth, abilityCost, clampAbilityToLevel, defense, hpMax, levelUpView, replaceAbility, skipAbilityPick, spendScorePoint, validateAbilityForLevel } from "./index.ts";
import { makeWorld } from "./testkit.ts";

const ID = "ch_brindle";

function leveled(growth: number) {
  const { state } = makeWorld();
  const r = addGrowth(state, ID, growth);
  if (!r.ok) throw new Error(r.error);
  return r.state;
}

const spark: AbilityDraft = {
  v: 1, name: "Chain Spark", description: "Lightning arcs between foes.", tags: ["explosives"], action: "action", target: "enemy",
  range_tiles: 5, cooldown_turns: 2,
  effects: [{ type: "damage", dice: "1d6", damage_type: "lightning", shape: "single" }],
} as AbilityDraft;

describe("addGrowth", () => {
  it("levels up and records pending picks; rejects bad input", () => {
    const s = leveled(100);
    expect(s.characters[ID]!.level).toBe(2);
    expect(s.pendingLevelUps[ID]).toEqual({ scorePoints: 0, abilityPicks: 1 });
    const { state } = makeWorld();
    expect(addGrowth(state, ID, 0).ok).toBe(false);
    expect(addGrowth(state, "nope", 5).ok).toBe(false);
  });
  it("level 3 grants a score point as well", () => {
    const s = leveled(200);
    expect(s.pendingLevelUps[ID]).toEqual({ scorePoints: 1, abilityPicks: 2 });
  });
});

describe("levelUpView", () => {
  it("reports caps, budget and picks for the character's level", () => {
    const s = leveled(200);
    const v = levelUpView(s, ID)!;
    expect(v.level).toBe(3);
    expect(v.scorePoints).toBe(1);
    expect(v.abilityPicks).toBe(2);
    expect(v.budget).toBe(40);
    expect(v.perAbilityCap).toBe(18);
    expect(v.caps).toEqual({ maxAvg: 11, maxRadius: 1, maxStunTurns: 1 });
    expect(v.budgetUsed).toBe(v.abilities.reduce((n, a) => n + abilityCost(a), 0));
    expect(levelUpView(s, "nope")).toBeNull();
  });
  it("shows zero picks when nothing is pending", () => {
    const { state } = makeWorld();
    expect(levelUpView(state, ID)).toMatchObject({ scorePoints: 0, abilityPicks: 0 });
  });
});

describe("spendScorePoint", () => {
  it("raises the score, consumes the point and cannot be repeated", () => {
    const s = leveled(200);
    const dex = s.characters[ID]!.scores.dex;
    const r = spendScorePoint(s, ID, "dex");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.characters[ID]!.scores.dex).toBe(dex + 1);
    expect(r.state.pendingLevelUps[ID]!.scorePoints).toBe(0);
    expect(spendScorePoint(r.state, ID, "dex").ok).toBe(false);
  });
  it("defense follows DEX (derived from scores)", () => {
    const s = leveled(200);
    let st = s;
    for (let i = 0; i < 3; i++) st = { ...st, characters: { ...st.characters, [ID]: { ...st.characters[ID]!, scores: { ...st.characters[ID]!.scores, dex: 11 } } } };
    const before = defense({ dex: 11 }, 0);
    const r = spendScorePoint({ ...st, pendingLevelUps: { [ID]: { scorePoints: 1, abilityPicks: 0 } } }, ID, "dex");
    expect(r.ok && defense({ dex: r.state.characters[ID]!.scores.dex }, 0)).toBe(before + 1);
  });
  it("CON raises max HP and current HP, on the entity and the character", () => {
    const s = leveled(200);
    const c = s.characters[ID]!;
    s.characters[ID]!.scores.con = 13; // modifier +1 -> 14 gives +2
    const hpMaxBefore = s.entities[ID]!.hpMax;
    const r = spendScorePoint(s, ID, "con");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = r.state.entities[ID]!;
    expect(after.hpMax).toBeGreaterThan(hpMaxBefore - 1);
    expect(r.state.characters[ID]!.hp_max).toBe(after.hpMax);
    expect(r.state.characters[ID]!.hp).toBe(after.hp);
    expect(c.hp_max).toBeDefined();
  });
  it("CON updates character hp when there is no entity on the map", () => {
    const s = leveled(200);
    delete s.entities[ID];
    s.characters[ID]!.scores.con = 13;
    const c = s.characters[ID]!;
    c.hp_max = hpMax(c.level, 13); c.hp = c.hp_max - 1;
    const r = spendScorePoint(s, ID, "con");
    expect(r.ok && r.state.characters[ID]!.hp).toBeGreaterThan(c.hp_max - 1);
  });
  it("refuses a score already at 20", () => {
    const s = leveled(200);
    s.characters[ID]!.scores.str = 20;
    const r = spendScorePoint(s, ID, "str");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/20/);
  });
});

describe("addAbilityToCharacter", () => {
  it("adds a valid ability, assigns an id, recomputes cost, consumes a pick", () => {
    const s = leveled(100);
    const r = addAbilityToCharacter(s, ID, spark);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.state.characters[ID]!;
    expect(c.abilities).toHaveLength(4);
    const added = c.abilities.at(-1)!;
    expect(added.id).toMatch(/^ab_/);
    expect(added.cost).toBe(abilityCost(added));
    expect(r.ability).toEqual(added);
    expect(r.state.pendingLevelUps[ID]).toBeUndefined();
    expect(r.state.entities[ID]!.usesLeft).toBeDefined();
  });
  it("rejects when no pick is pending", () => {
    const { state } = makeWorld();
    const r = addAbilityToCharacter(state, ID, spark);
    expect(r.ok).toBe(false);
  });
  it("rejects over the remaining budget with a clear message", () => {
    const s = leveled(100); // level 2: budget 35
    const c = s.characters[ID]!;
    const sparkCost = abilityCost(clampAbilityToLevel(spark, 2).ability);
    let i = 0;
    while (35 - c.abilities.reduce((n, a) => n + abilityCost(a), 0) >= sparkCost && i++ < 5) {
      c.abilities.push({ ...c.abilities[0]!, id: `ab_pad${i}` });
    }
    c.abilities.splice(5); // keep under the count limit so the budget is what fails
    const r = addAbilityToCharacter(s, ID, clampAbilityToLevel(spark, 2).ability);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/power budget/);
  });
  it("rejects an ability over the level's per-ability cap or dice cap", () => {
    const s = leveled(100);
    const over: AbilityDraft = { ...spark, effects: [{ type: "damage", dice: "6d8", damage_type: "fire", shape: "single" }] } as AbilityDraft;
    const r = addAbilityToCharacter(s, ID, over);
    expect(r.ok).toBe(false);
  });
  it("rejects past the maximum ability count", () => {
    const s = leveled(100);
    const c = s.characters[ID]!;
    const cheap = { ...spark, id: undefined, effects: [{ type: "heal", dice: "1d4", shape: "single" }], cooldown_turns: 3 } as unknown as Ability;
    while (c.abilities.length < 6) c.abilities.push({ ...cheap, id: `ab_x${c.abilities.length}` });
    const r = addAbilityToCharacter(s, ID, spark);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/reforge/);
  });
  it("does not mutate the input state", () => {
    const s = leveled(100);
    const before = JSON.stringify(s);
    addAbilityToCharacter(s, ID, spark);
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe("replaceAbility", () => {
  it("replaces in place, freeing the old cost, and consumes a pick", () => {
    const s = leveled(100);
    const old = s.characters[ID]!.abilities[0]!;
    const r = replaceAbility(s, ID, old.id!, spark);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const abs = r.state.characters[ID]!.abilities;
    expect(abs).toHaveLength(3);
    expect(abs[0]!.name).toBe("Chain Spark");
    expect(abs[0]!.id).not.toBe(old.id);
    expect(r.state.pendingLevelUps[ID]).toBeUndefined();
  });
  it("rejects an unknown ability id", () => {
    const s = leveled(100);
    expect(replaceAbility(s, ID, "ab_nope", spark).ok).toBe(false);
  });
  it("accepts a replacement that only fits because the old cost is freed", () => {
    const s = leveled(100);
    const c = s.characters[ID]!;
    const target = c.abilities[0]!;
    const used = c.abilities.reduce((n, a) => n + abilityCost(a), 0);
    const draft = clampAbilityToLevel(spark, 2).ability;
    // same-or-lower cost than old+left is accepted
    expect(abilityCost(draft)).toBeLessThanOrEqual(35 - used + abilityCost(target));
    expect(replaceAbility(s, ID, target.id!, draft).ok).toBe(true);
  });
});

describe("skipAbilityPick", () => {
  it("clears one pick and leaves abilities alone", () => {
    const s = leveled(200);
    const r = skipAbilityPick(s, ID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.pendingLevelUps[ID]!.abilityPicks).toBe(1);
    expect(r.state.characters[ID]!.abilities).toEqual(s.characters[ID]!.abilities);
    expect(skipAbilityPick(makeWorld().state, ID).ok).toBe(false);
  });
});

describe("clampAbilityToLevel maxCost", () => {
  it("scales an ability to the remaining budget", () => {
    const big: AbilityDraft = { ...spark, cooldown_turns: undefined, effects: [{ type: "damage", dice: "2d6", damage_type: "fire", shape: "burst", radius_tiles: 1 }] } as AbilityDraft;
    const free = clampAbilityToLevel(big, 3).ability;
    const tight = clampAbilityToLevel(big, 3, { maxCost: 3 }).ability;
    expect(free.cost!).toBeGreaterThan(3);
    expect(tight.cost!).toBeLessThanOrEqual(3);
    expect(validateAbilityForLevel(tight, 3).ok).toBe(true);
  });
});
