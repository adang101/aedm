import { describe, expect, it } from "vitest";
import { AbilityDraftSchema, AbilitySchema, EffectSchema } from "./ability";
import { ABILITY_FIXTURES } from "./fixtures/abilities";

const base = {
  v: 1, name: "Zap", description: "Zaps.", tags: [], action: "action", target: "enemy",
  range_tiles: 4, cooldown_turns: 2,
  effects: [{ type: "damage", shape: "single", dice: "1d6", damage_type: "fire" }],
};

describe("worked example fixtures", () => {
  it("has the 14 worked examples, all parse", () => {
    expect(ABILITY_FIXTURES).toHaveLength(14);
    for (const f of ABILITY_FIXTURES) {
      const r = AbilitySchema.safeParse(f.ability);
      expect(r.success, f.ability.name).toBe(true);
      expect(AbilityDraftSchema.safeParse(f.ability).success, f.ability.name).toBe(true);
    }
  });
});

describe("Ability", () => {
  it("id and cost optional", () => {
    expect(AbilitySchema.safeParse(base).success).toBe(true);
    expect(AbilitySchema.safeParse({ ...base, id: "ab_zap", cost: 3 }).success).toBe(true);
  });
  it("rejects unknown fields and bad id", () => {
    expect(AbilitySchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(AbilitySchema.safeParse({ ...base, id: "zap" }).success).toBe(false);
    expect(EffectSchema.safeParse({ type: "damage", shape: "single", dice: "1d6", damage_type: "fire", bogus: 1 }).success).toBe(false);
  });
  it("trims strings", () => {
    const r = AbilitySchema.parse({ ...base, name: "  Zap  " });
    expect(r.name).toBe("Zap");
  });
  it("cooldown XOR uses_per_rest", () => {
    const { cooldown_turns: _c, ...noCd } = base;
    expect(AbilitySchema.safeParse(noCd).success).toBe(false);
    expect(AbilitySchema.safeParse({ ...base, uses_per_rest: 1 }).success).toBe(false);
    expect(AbilitySchema.safeParse({ ...noCd, uses_per_rest: 2 }).success).toBe(true);
    expect(AbilitySchema.safeParse({ ...noCd, uses_per_rest: 4 }).success).toBe(false);
    expect(AbilitySchema.safeParse({ ...base, cooldown_turns: 7 }).success).toBe(false);
  });
  it("effects 1 to 4", () => {
    expect(AbilitySchema.safeParse({ ...base, effects: [] }).success).toBe(false);
    const e = base.effects[0]!;
    expect(AbilitySchema.safeParse({ ...base, effects: [e, e, e, e, e] }).success).toBe(false);
  });
  it("dice validated inside effects", () => {
    expect(EffectSchema.safeParse({ type: "damage", shape: "single", dice: "9d6", damage_type: "fire" }).success).toBe(false);
    expect(EffectSchema.safeParse({ type: "heal", shape: "single", dice: "2d5" }).success).toBe(false);
  });
  it("effect union rejects unknown type", () => {
    expect(EffectSchema.safeParse({ type: "resurrect" }).success).toBe(false);
  });
  it("shape rules", () => {
    const dmg = { type: "damage", dice: "1d6", damage_type: "fire" };
    expect(EffectSchema.safeParse({ ...dmg, shape: "burst" }).success).toBe(false);
    expect(EffectSchema.safeParse({ ...dmg, shape: "burst", radius_tiles: 3 }).success).toBe(false);
    expect(EffectSchema.safeParse({ ...dmg, shape: "line", length_tiles: 6 }).success).toBe(true);
    expect(EffectSchema.safeParse({ ...dmg, shape: "cone", length_tiles: 5 }).success).toBe(false);
    expect(EffectSchema.safeParse({ ...dmg, shape: "single", radius_tiles: 1 }).success).toBe(false);
    expect(EffectSchema.safeParse({ ...dmg, shape: "single", save: { ability: "dex", dc: "caster_dc" } }).success).toBe(false);
  });
  it("terrain damage only for fire and trap", () => {
    const t = { type: "terrain", shape: "tile", dice: "1d6", damage_type: "sharp" };
    expect(EffectSchema.safeParse({ ...t, kind: "trap" }).success).toBe(true);
    expect(EffectSchema.safeParse({ ...t, kind: "wall" }).success).toBe(false);
    expect(EffectSchema.safeParse({ type: "terrain", kind: "trap", shape: "tile", dice: "1d6" }).success).toBe(false);
  });
  it("tags limited to allowed list and 2", () => {
    expect(AbilitySchema.safeParse({ ...base, tags: ["parkour"] }).success).toBe(false);
    expect(AbilitySchema.safeParse({ ...base, tags: ["speed", "stealth", "lore"] }).success).toBe(false);
  });
  it("draft accepts forge_notes and ignores cost of any type", () => {
    expect(AbilityDraftSchema.safeParse({ ...base, forge_notes: "ok", cost: "9" }).success).toBe(true);
    expect(AbilityDraftSchema.safeParse({ ...base, wat: 1 }).success).toBe(false);
  });
});
