import { describe, expect, it } from "vitest";
import type { Enemy } from "@aedm/schemas";
import { clampEnemy, encounterBudget, enemyRangesForLevel, enemyThreat, standardEnemy, threatFromStats, validateEnemy } from "./threat.ts";
import { abilityCost } from "./cost.ts";

const borrowedVoice = {
  v: 1 as const, name: "Borrowed Voice", description: "dazzle", tags: [], action: "action" as const, target: "enemy" as const,
  range_tiles: 6, cooldown_turns: 3,
  effects: [{ type: "condition" as const, condition: "dazzled" as const, duration_turns: 1, on: "failed_save" as const, save: { ability: "wis" as const, dc: "caster_dc" as const } }],
};

const chorister: Enemy = {
  v: 1, name: "Robed Chorister", concept: "Borrows the voices of the drowned.", role: "standard",
  stats: { hp: 10, defense: 12, attack_bonus: 3, speed: 6, damage_dice: "1d6" },
  weakness: null, resistance: null, behavior: ["Keeps to the back", "Sings at the nearest foe"],
  loot_hint: "", sprite_tags: [], abilities: [borrowedVoice],
};

describe("threat", () => {
  it("borrowed voice costs 2", () => expect(abilityCost(borrowedVoice)).toBe(2));
  it("robed chorister is 13.5 (damage per round 4)", () => {
    expect(threatFromStats({ hp: 10, defense: 12, damagePerRound: 4, speed: 6, abilityCosts: [2] })).toBe(13.5);
  });
  it("standard enemy table rows", () => {
    for (const [lvl, t] of [[1, 12.5], [3, 22], [5, 38], [7, 51], [10, 71.5]] as const) {
      const s = standardEnemy(lvl);
      expect(threatFromStats({ hp: s.hp, defense: s.defense, damagePerRound: s.damage, speed: 6, abilityCosts: [] })).toBe(t);
    }
  });
  it("enemyThreat uses the dice average (1d6 = 3.5)", () => {
    expect(enemyThreat(chorister)).toBe(12.75);
  });
  it("two choristers fit inside budget 39", () => {
    expect(2 * 13.5).toBeLessThanOrEqual(encounterBudget(3, 1, "standard"));
  });
});

describe("encounter budget", () => {
  it("39 for 3 level-1, 52 for 4", () => {
    expect(encounterBudget(3, 1, "standard")).toBe(39);
    expect(encounterBudget(4, 1, "standard")).toBe(52);
  });
  it("difficulty multipliers", () => {
    expect(encounterBudget(3, 1, "easy")).toBe(19.5);
    expect(encounterBudget(3, 1, "hard")).toBe(58.5);
    expect(encounterBudget(3, 1, "deadly")).toBe(78);
  });
  it("boss encounters get 1.5x", () => {
    expect(encounterBudget(3, 1, "standard", { boss: true })).toBe(58.5);
  });
});

describe("ranges", () => {
  it("level 1 standard", () => {
    const r = enemyRangesForLevel(1, "standard");
    expect(r.hp).toEqual({ min: 8, max: 12 });
    expect(r.defense).toEqual({ min: 11, max: 13 });
    expect(r.attack).toEqual({ min: 2, max: 4 });
    expect(r.damageHundredths).toEqual({ min: 320, max: 480 });
  });
  it("interpolates between rows", () => {
    expect(standardEnemy(2)).toMatchObject({ hp: 16, damage: 5.5 });
    expect(standardEnemy(4)).toMatchObject({ hp: 31 });
  });
  it("role multipliers", () => {
    expect(enemyRangesForLevel(1, "minion").hp).toEqual({ min: 4, max: 6 });
    expect(enemyRangesForLevel(1, "elite").hp.max).toBe(18);
    expect(enemyRangesForLevel(1, "boss").hp.max).toBe(24);
    expect(enemyRangesForLevel(1, "minion").abilities).toEqual({ min: 0, max: 0 });
    expect(enemyRangesForLevel(1, "boss").abilities).toEqual({ min: 1, max: 3 });
  });
});

describe("validateEnemy / clampEnemy", () => {
  it("accepts the chorister at level 1", () => expect(validateEnemy(chorister, 1)).toEqual({ ok: true, errors: [] }));
  it("rejects an overpowered enemy", () => {
    const e = { ...chorister, stats: { ...chorister.stats, hp: 80, defense: 20, damage_dice: "4d8" } };
    const r = validateEnemy(e, 1);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });
  it("rejects minion with abilities", () => {
    expect(validateEnemy({ ...chorister, role: "minion" }, 1).ok).toBe(false);
  });
  it("clamps into range and the result validates", () => {
    const e = { ...chorister, stats: { ...chorister.stats, hp: 80, defense: 20, attack_bonus: 12, damage_dice: "4d8", speed: 12 } };
    const r = clampEnemy(e, 1);
    expect(validateEnemy(r.enemy, 1)).toEqual({ ok: true, errors: [] });
    expect(r.notes.length).toBeGreaterThan(0);
    expect(r.enemy.threat).toBeCloseTo(enemyThreat(r.enemy), 5);
  });
  it("clamp strips abilities from minions and truncates extras", () => {
    const r = clampEnemy({ ...chorister, role: "minion", stats: { ...chorister.stats, hp: 5 } }, 1);
    expect(r.enemy.abilities).toHaveLength(0);
  });
});
