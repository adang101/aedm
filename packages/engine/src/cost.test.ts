import { describe, expect, it } from "vitest";
import { fixtures, type Ability } from "@aedm/schemas";
import { abilityCost, abilityCostHundredths, clampAbilityToLevel, validateAbilityForLevel, validateCharacterAbilities } from "./cost.ts";

describe("ability cost fixtures", () => {
  it("has all 14 worked examples", () => expect(fixtures.ABILITY_FIXTURES).toHaveLength(14));
  for (const f of fixtures.ABILITY_FIXTURES) {
    it(`${f.ability.name}: ${f.expectedCost} (${f.expectedCostHundredths}h)`, () => {
      expect(abilityCostHundredths(f.ability)).toBe(f.expectedCostHundredths);
      expect(abilityCost(f.ability)).toBe(f.expectedCost);
    });
  }
});

describe("spike-kit level 1 totals", () => {
  const [brindle, tamsin, orrin] = fixtures.SPIKE_PARTY;
  it("Brindle 19, Tamsin 13, Orrin 8", () => {
    const total = (abs: Ability[]) => abs.reduce((s, a) => s + abilityCost(a), 0);
    expect(total(brindle!.abilities)).toBe(19);
    expect(total(tamsin!.abilities)).toBe(13);
    expect(total(orrin!.abilities)).toBe(8);
  });
  it("all validate at level 1", () => {
    for (const c of fixtures.SPIKE_PARTY) {
      expect(validateCharacterAbilities(c.abilities, 1)).toEqual({ ok: true, errors: [], total: expect.any(Number) });
    }
  });
});

describe("integer math", () => {
  it("5 x 0.6 does not round up to 4", () => {
    const a: Ability = {
      v: 1, name: "x", description: "x", tags: [], action: "action", target: "tile", range_tiles: 4, uses_per_rest: 2,
      effects: [{ type: "terrain", kind: "trap", shape: "tile", dice: "1d6", damage_type: "sharp" }],
    };
    expect(abilityCostHundredths(a)).toBe(300);
    expect(abilityCost(a)).toBe(3);
  });
});

const base = (over: Partial<Ability>): Ability => ({
  v: 1, name: "t", description: "t", tags: [], action: "action", target: "enemy", range_tiles: 4, cooldown_turns: 2,
  effects: [{ type: "damage", shape: "single", dice: "1d6", damage_type: "fire" }], ...over,
} as Ability);

describe("validateAbilityForLevel", () => {
  it("rejects over-average damage", () => {
    const a = base({ effects: [{ type: "damage", shape: "single", dice: "3d6", damage_type: "fire" }] });
    const r = validateAbilityForLevel(a, 1);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/average/i);
    expect(validateAbilityForLevel(a, 5).ok).toBe(true);
  });
  it("rejects radius 2 at level 1 and stun 2 turns", () => {
    const a = base({ effects: [{ type: "damage", shape: "burst", radius_tiles: 2, dice: "1d6", damage_type: "fire" }] });
    expect(validateAbilityForLevel(a, 1).errors.join(" ")).toMatch(/radius/i);
    const s = base({ effects: [{ type: "condition", condition: "stunned", duration_turns: 2, on: "always" }] });
    expect(validateAbilityForLevel(s, 1).errors.join(" ")).toMatch(/stun/i);
    expect(validateAbilityForLevel(s, 7).ok).toBe(true);
  });
  it("rejects over per-ability cap", () => {
    const a = base({
      cooldown_turns: 0, range_tiles: 12,
      effects: [
        { type: "damage", shape: "burst", radius_tiles: 1, dice: "2d6", damage_type: "fire" },
        { type: "condition", condition: "stunned", duration_turns: 1, on: "always" },
      ],
    });
    const r = validateAbilityForLevel(a, 1);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/cap/i);
  });
  it("rejects range over 12", () => {
    expect(validateAbilityForLevel({ ...base({}), range_tiles: 13 }, 10).ok).toBe(false);
  });
});

describe("validateCharacterAbilities", () => {
  it("rejects total over budget", () => {
    const big = fixtures.fixtureAbility("Shaped Charge"); // 11
    const r = validateCharacterAbilities([big, { ...big, id: "ab_b" }, { ...big, id: "ab_c" }], 1);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/budget/i);
  });
});

describe("clampAbilityToLevel", () => {
  it("scales an over-cap draft down so that it validates", () => {
    const draft = base({
      cooldown_turns: 0, range_tiles: 12,
      effects: [
        { type: "damage", shape: "burst", radius_tiles: 2, dice: "6d8", damage_type: "fire", save: { ability: "dex", dc: "caster_dc" }, on_save: "half" },
        { type: "condition", condition: "stunned", duration_turns: 3, on: "failed_save", save: { ability: "dex", dc: "caster_dc" } },
      ],
    });
    const r = clampAbilityToLevel(draft, 1);
    expect(validateAbilityForLevel(r.ability, 1)).toEqual({ ok: true, errors: [] });
    expect(r.notes.length).toBeGreaterThan(0);
    expect(r.ability.cost).toBe(abilityCost(r.ability));
  });
  it("leaves a valid ability untouched", () => {
    const f = fixtures.fixtureAbility("Slipstream");
    const r = clampAbilityToLevel(f, 1);
    expect(r.notes).toEqual([]);
    expect(r.ability.effects).toEqual(f.effects);
  });
  it("switches to uses_per_rest when still over the cap", () => {
    const draft = base({
      cooldown_turns: 0, range_tiles: 12,
      effects: [
        { type: "damage", shape: "burst", radius_tiles: 1, dice: "2d6", damage_type: "fire", save: { ability: "dex", dc: "caster_dc" }, on_save: "half" },
        { type: "condition", condition: "stunned", duration_turns: 1, on: "failed_save", save: { ability: "dex", dc: "caster_dc" } },
      ],
    });
    const r = clampAbilityToLevel(draft, 1);
    expect(r.ability.uses_per_rest).toBe(1);
    expect(r.ability.cooldown_turns).toBeUndefined();
  });
});
