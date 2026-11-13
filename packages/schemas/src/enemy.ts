import { z } from "zod";
import { AbilityDraftSchema, AbilitySchema } from "./ability";
import { ConditionSchema, DamageTypeSchema, EnemyRoleSchema } from "./enums";
import { SpriteRecipeSchema } from "./character";
import { AppearanceSchema } from "./sprite";
import { EnemyIdSchema, EnemyStatsSchema, shortWord, text } from "./common";

const weakness = z.union([DamageTypeSchema, ConditionSchema]).nullable();
const resistance = DamageTypeSchema.nullable();

const enemyFields = {
  name: text(40),
  concept: text(200),
  role: EnemyRoleSchema,
  stats: EnemyStatsSchema,
  weakness,
  resistance,
  behavior: z.array(text(80)).min(2).max(3),
  loot_hint: text(80, 0).default(""),
  sprite_tags: z.array(shortWord).max(5).default([]),
  /** Look hint for the sprite designer (concept plus appearance). */
  appearance: AppearanceSchema.optional(),
};

export const EnemySchema = z
  .strictObject({
    v: z.literal(1),
    id: EnemyIdSchema.optional(),
    ...enemyFields,
    abilities: z.array(AbilitySchema).max(3),
    /** Designed look, set by the server after the sprite designer runs. Every spawned entity uses it. */
    sprite: SpriteRecipeSchema.optional(),
    /** Computed by the engine; ignored on input. */
    threat: z.number().optional(),
  })
  .refine((e) => e.role !== "minion" || e.abilities.length === 0, {
    message: "minions have no abilities",
    path: ["abilities"],
  });
export type Enemy = z.infer<typeof EnemySchema>;

/** What the enemy builder model returns. */
export const EnemyDraftSchema = z
  .strictObject({
    v: z.literal(1).optional(),
    id: z.string().optional(),
    ...enemyFields,
    abilities: z.array(AbilityDraftSchema).max(3),
    threat: z.unknown().optional(),
  })
  .refine((e) => e.role !== "minion" || e.abilities.length === 0, {
    message: "minions have no abilities",
    path: ["abilities"],
  });
export type EnemyDraft = z.infer<typeof EnemyDraftSchema>;
