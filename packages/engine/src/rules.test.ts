import { describe, expect, it } from "vitest";
import { fixtures } from "@aedm/schemas";
import {
  abilityModifier, defense, hpMax, initiativeBonus, levelCaps, levelFromGrowth, lootCap, pointBuyCost,
  proficiency, speed, validatePointBuy, armorInfo, growthToNextLevel,
} from "./rules.ts";
import { LEVELS } from "./data.ts";

describe("ability modifier table", () => {
  it.each([[8, -1], [9, -1], [10, 0], [11, 0], [12, 1], [13, 1], [14, 2], [15, 2], [16, 3], [17, 3], [18, 4], [19, 4], [20, 5]])(
    "score %i -> %i", (score, mod) => expect(abilityModifier(score)).toBe(mod));
});

describe("point buy", () => {
  it("costs", () => {
    expect([8, 9, 10, 11, 12, 13, 14, 15].map(pointBuyCost)).toEqual([0, 1, 2, 3, 4, 5, 7, 9]);
  });
  it("validates the spike party at exactly 27", () => {
    for (const c of fixtures.SPIKE_PARTY) {
      const r = validatePointBuy(c.scores);
      expect(r.errors).toEqual([]);
      expect(r.total).toBe(27);
      expect(r.ok).toBe(true);
    }
  });
  it("rejects wrong totals and out of range scores", () => {
    expect(validatePointBuy({ str: 8, dex: 8, dex2: 8 } as never).ok).toBe(false);
    expect(validatePointBuy({ str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 }).ok).toBe(false);
    expect(validatePointBuy({ str: 16, dex: 8, con: 8, int: 8, wis: 8, cha: 8 }).ok).toBe(false);
    expect(validatePointBuy({ str: 7, dex: 15, con: 15, int: 15, wis: 8, cha: 8 }).ok).toBe(false);
  });
});

describe("level table", () => {
  it("proficiency", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(proficiency)).toEqual([2, 2, 2, 2, 3, 3, 3, 3, 4, 4]);
  });
  it("budget is 25 + 5L, cap is 45% rounded down, avg is 5 + 2L", () => {
    for (const row of LEVELS) {
      expect(row.budget).toBe(25 + 5 * row.level);
      expect(row.perAbilityCap).toBe(Math.floor((row.budget * 45) / 100));
      expect(row.maxAverage).toBe(5 + 2 * row.level);
    }
  });
  it("levelCaps", () => {
    expect(levelCaps(1)).toMatchObject({ budget: 30, perAbilityCap: 13, maxAverage: 7, maxRadius: 1, maxConditionTurns: 1, maxStunTurns: 1, weaponTier: 1, proficiency: 2 });
    expect(levelCaps(10)).toMatchObject({ budget: 75, perAbilityCap: 33, maxAverage: 25, maxRadius: 2, maxConditionTurns: 3, maxStunTurns: 2, weaponTier: 5, proficiency: 4 });
    expect(levelCaps(99).budget).toBe(75);
    expect(levelCaps(0).budget).toBe(30);
  });
  it("loot cap", () => {
    expect(lootCap(1)).toBe(30);
    expect(lootCap(5)).toBe(70);
  });
  it("level from growth carries overflow, caps at 10", () => {
    expect(levelFromGrowth(0)).toBe(1);
    expect(levelFromGrowth(99)).toBe(1);
    expect(levelFromGrowth(100)).toBe(2);
    expect(levelFromGrowth(250)).toBe(3);
    expect(levelFromGrowth(100000)).toBe(10);
    expect(growthToNextLevel(250)).toBe(50);
  });
});

describe("hp, defense, speed, initiative", () => {
  it("hp matches the spike party", () => {
    for (const c of fixtures.SPIKE_PARTY) expect(hpMax(1, c.scores.con)).toBe(c.hp_max);
  });
  it("later levels add 6 + CON, at least 1", () => {
    expect(hpMax(2, 14)).toBe(12 + 8);
    expect(hpMax(3, 1)).toBe(10 - 5 + 2 * 1);
  });
  it("defense = 10 + dex + armor; medium caps dex at +2; heavy ignores dex", () => {
    expect(defense({ dex: 15 }, 2)).toBe(14);
    expect(defense({ dex: 13 }, 2)).toBe(13);
    expect(defense({ dex: 20 }, 4)).toBe(10 + 2 + 4);
    expect(defense({ dex: 20 }, 6)).toBe(16);
    expect(defense({ dex: 8 }, 0)).toBe(9);
  });
  it("spike party defenses", () => {
    expect(fixtures.SPIKE_PARTY.map((c) => defense(c.scores, c.armor_bonus))).toEqual([13, 14, 13]);
  });
  it("speed with conditions and armor", () => {
    expect(speed({ conditions: [], armorBonus: 2 })).toBe(6);
    expect(speed({ conditions: ["hasted"], armorBonus: 2 })).toBe(8);
    expect(speed({ conditions: ["slowed"], armorBonus: 2 })).toBe(4);
    expect(speed({ conditions: ["rooted"], armorBonus: 2 })).toBe(0);
    expect(speed({ conditions: ["slowed"], armorBonus: 6 })).toBe(3);
    expect(speed({ conditions: ["slowed"], baseSpeed: 2, armorBonus: 0 })).toBe(1);
    expect(speed({ conditions: ["hasted", "slowed"], armorBonus: 0 })).toBe(6);
  });
  it("initiative uses dex mod", () => {
    expect(initiativeBonus(15)).toBe(2);
  });
  it("armor info", () => {
    expect(armorInfo(6).speedPenalty).toBe(1);
  });
});
