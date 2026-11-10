import { describe, expect, it } from "vitest";
import { CharacterCreateSchema, CharacterSchema, CharacterViewSchema, SpriteRecipeSchema } from "./character";
import { BRINDLE, SPIKE_PARTY } from "./fixtures/party";

const create = {
  v: 1, name: "Maren", title: "retired chorister", description: "Sings softly.",
  key_ability: "cha",
  scores: { str: 8, dex: 12, con: 13, int: 10, wis: 13, cha: 15 },
  trait_tags: ["performance", "lore"],
  sprite_recipe: { kind: "shape", shape: "diamond", color: "#112233", accent: "#ffeedd", glyph: "M" },
  ability_texts: ["Reality Chorus: sing a chord that stuns everything nearby."],
};

describe("Character", () => {
  it("spike party fixtures parse", () => {
    for (const c of SPIKE_PARTY) expect(CharacterSchema.safeParse(c).success, c.name).toBe(true);
    expect(SPIKE_PARTY.map((c) => c.abilities.length)).toEqual([3, 3, 3]);
  });
  it("view omits private fields", () => {
    const { user_id: _u, campaign_id: _c, inventory: _i, ...pub } = BRINDLE;
    expect(CharacterViewSchema.safeParse(pub).success).toBe(true);
    expect(CharacterViewSchema.safeParse(BRINDLE).success).toBe(false);
  });
  it("rejects unknown fields and duplicate/wrong-count tags", () => {
    expect(CharacterSchema.safeParse({ ...BRINDLE, secret: 1 }).success).toBe(false);
    expect(CharacterSchema.safeParse({ ...BRINDLE, trait_tags: ["speed"] }).success).toBe(false);
    expect(CharacterSchema.safeParse({ ...BRINDLE, trait_tags: ["speed", "speed"] }).success).toBe(false);
  });
});

describe("SpriteRecipe", () => {
  it("validates shape recipe", () => {
    expect(SpriteRecipeSchema.safeParse(create.sprite_recipe).success).toBe(true);
    expect(SpriteRecipeSchema.safeParse({ ...create.sprite_recipe, color: "red" }).success).toBe(false);
    expect(SpriteRecipeSchema.safeParse({ ...create.sprite_recipe, glyph: "abc" }).success).toBe(false);
    expect(SpriteRecipeSchema.safeParse({ ...create.sprite_recipe, glyph: "" }).success).toBe(false);
    expect(SpriteRecipeSchema.safeParse({ ...create.sprite_recipe, shape: "star" }).success).toBe(false);
    expect(SpriteRecipeSchema.safeParse({ kind: "parts" }).success).toBe(false);
  });
});

describe("CharacterCreate", () => {
  it("accepts ability_texts", () => {
    expect(CharacterCreateSchema.safeParse(create).success).toBe(true);
  });
  it("accepts prebuilt abilities instead", () => {
    const { ability_texts: _t, ...rest } = create;
    const abilities = BRINDLE.abilities;
    expect(CharacterCreateSchema.safeParse({ ...rest, abilities }).success).toBe(true);
  });
  it("needs exactly one source of abilities", () => {
    const { ability_texts: _t, ...rest } = create;
    expect(CharacterCreateSchema.safeParse(rest).success).toBe(false);
    expect(CharacterCreateSchema.safeParse({ ...create, abilities: BRINDLE.abilities }).success).toBe(false);
  });
  it("limits texts", () => {
    expect(CharacterCreateSchema.safeParse({ ...create, ability_texts: ["x".repeat(301)] }).success).toBe(false);
    expect(CharacterCreateSchema.safeParse({ ...create, ability_texts: [] }).success).toBe(false);
    expect(CharacterCreateSchema.safeParse({ ...create, ability_texts: ["a", "b", "c", "d"] }).success).toBe(false);
  });
  it("rejects engine-owned fields and out-of-range scores", () => {
    expect(CharacterCreateSchema.safeParse({ ...create, hp: 99 }).success).toBe(false);
    expect(CharacterCreateSchema.safeParse({ ...create, level: 5 }).success).toBe(false);
    expect(CharacterCreateSchema.safeParse({ ...create, scores: { ...create.scores, str: 16 } }).success).toBe(false);
    expect(CharacterCreateSchema.safeParse({ ...create, trait_tags: ["lore", "performance", "stealth"] }).success).toBe(false);
  });
});
