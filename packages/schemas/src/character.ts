import { z } from "zod";
import { AbilityDraftSchema, AbilitySchema } from "./ability";
import { AbilityScoreKeySchema, CheckTagSchema, SpriteShapeSchema } from "./enums";
import { EntityIdSchema, HexColorSchema, text } from "./common";
import { ItemSchema } from "./world";
import { SpriteSpecSchema } from "./sprite";

const glyph = z.string().trim().refine((s) => {
  const n = [...s].length;
  return n >= 1 && n <= 2;
}, { message: "glyph must be 1 to 2 characters" });

export const ShapeSpriteRecipeSchema = z.strictObject({
  kind: z.literal("shape"),
  shape: SpriteShapeSchema,
  color: HexColorSchema,
  accent: HexColorSchema,
  glyph,
});
export type ShapeSpriteRecipe = z.infer<typeof ShapeSpriteRecipeSchema>;

/**
 * Discriminated on `kind`: `spec` (body plan, parts, palette; see sprite.ts) is the standard for new content,
 * `shape` (colored shape plus glyph) stays for backward compatibility and as the fallback drawing.
 */
export const SpriteRecipeSchema = z.discriminatedUnion("kind", [ShapeSpriteRecipeSchema, SpriteSpecSchema]);
export type SpriteRecipe = z.infer<typeof SpriteRecipeSchema>;

/** Two colors and a short glyph for badges, initiative dots and list swatches, whatever the recipe kind. */
export function spriteSwatch(r: SpriteRecipe, fallbackName = "?"): { color: string; accent: string; glyph: string } {
  if (r.kind === "shape") return { color: r.color, accent: r.accent, glyph: r.glyph };
  const glyph = r.glyph ?? ([...fallbackName.trim()][0] ?? "?").toUpperCase();
  return { color: r.palette.primary, accent: r.palette.accent, glyph };
}

const scoreFields = Object.fromEntries(
  ["str", "dex", "con", "int", "wis", "cha"].map((k) => [k, z.number().int().min(1).max(20)]),
) as Record<"str" | "dex" | "con" | "int" | "wis" | "cha", z.ZodNumber>;
export const AbilityScoresSchema = z.strictObject(scoreFields);
export type AbilityScores = z.infer<typeof AbilityScoresSchema>;

const creationScoreFields = Object.fromEntries(
  ["str", "dex", "con", "int", "wis", "cha"].map((k) => [k, z.number().int().min(8).max(15)]),
) as Record<"str" | "dex" | "con" | "int" | "wis" | "cha", z.ZodNumber>;
/** Scores at creation: each 8 to 15. The 27-point cost is checked by the engine. */
export const CreationScoresSchema = z.strictObject(creationScoreFields);

const traitTags = z
  .array(CheckTagSchema)
  .length(2)
  .refine((t) => t[0] !== t[1], { message: "trait tags must differ" });

const publicFields = {
  id: EntityIdSchema,
  name: text(30),
  title: text(40, 0).default(""),
  description: text(300, 0).default(""),
  key_ability: AbilityScoreKeySchema,
  scores: AbilityScoresSchema,
  trait_tags: traitTags,
  abilities: z.array(AbilitySchema).min(1).max(6),
  weapon_tier: z.number().int().min(1).max(5),
  armor_bonus: z.number().int().min(0).max(6),
  level: z.number().int().min(1).max(10),
  growth: z.number().int().min(0),
  hp: z.number().int().min(0),
  hp_max: z.number().int().min(1),
  sprite_recipe: SpriteRecipeSchema,
};

export const CharacterSchema = z.strictObject({
  v: z.literal(1),
  ...publicFields,
  campaign_id: EntityIdSchema,
  /** The account currently playing the character. */
  user_id: EntityIdSchema,
  inventory: z.array(ItemSchema).max(100),
});
export type Character = z.infer<typeof CharacterSchema>;

/** Character minus private fields (user_id, campaign_id). Inventory is optional (co-op: visible to the table). */
export const CharacterViewSchema = z.strictObject({
  v: z.literal(1),
  ...publicFields,
  /** Additive: the shared party pack, shown on the character sheet. */
  inventory: z.array(ItemSchema).max(100).optional(),
});
export type CharacterView = z.infer<typeof CharacterViewSchema>;

/**
 * What a client submits for a new character. Engine-owned fields (id, level, growth, hp, gear,
 * inventory) are absent. Supply either `ability_texts` (free text for the forge) or prebuilt `abilities`.
 */
export const CharacterCreateSchema = z
  .strictObject({
    v: z.literal(1),
    name: text(30),
    title: text(40, 0).default(""),
    description: text(300, 0).default(""),
    key_ability: AbilityScoreKeySchema,
    scores: CreationScoresSchema,
    trait_tags: traitTags,
    sprite_recipe: SpriteRecipeSchema,
    ability_texts: z.array(text(300)).min(1).max(3).optional(),
    abilities: z.array(AbilityDraftSchema).min(1).max(3).optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.ability_texts === undefined) === (v.abilities === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "provide exactly one of ability_texts and abilities",
        path: ["ability_texts"],
      });
    }
  });
export type CharacterCreate = z.infer<typeof CharacterCreateSchema>;
