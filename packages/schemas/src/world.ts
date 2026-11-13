import { z } from "zod";
import {
  ContentRatingSchema, DispositionSchema, ItemKindSchema, NpcRoleSchema, PlotArcSchema, PlotPatternSchema, QuestStatusSchema,
} from "./enums";
import { AppearanceSchema } from "./sprite";
import { EnemyStatsSchema, EntityIdSchema, MapIdSchema, shortWord, text } from "./common";

export { ContentRatingSchema };
export type { ContentRating } from "./enums";

export const WorldFactSchema = z.strictObject({
  subject: text(80),
  predicate: text(40),
  object: text(200),
});
export type WorldFact = z.infer<typeof WorldFactSchema>;

export const ItemSchema = z.strictObject({
  id: EntityIdSchema,
  name: text(40),
  kind: ItemKindSchema,
  value: z.number().int().min(0).max(100000),
  tier: z.number().int().min(1).max(5).optional(),
});
export type Item = z.infer<typeof ItemSchema>;

/** A plot stage id (snake_case, from packages/engine/data/plots.json). */
export const StageIdSchema = z.string().trim().min(1).max(40).regex(/^[a-z][a-z0-9_]*$/, "stage ids are snake_case");

export const MilestoneSchema = z.strictObject({
  id: EntityIdSchema,
  description: text(300),
  completed: z.boolean(),
  /** Plot stage this milestone belongs to. Optional so saves from before story structure still parse. */
  stage: StageIdSchema.optional(),
});
export type Milestone = z.infer<typeof MilestoneSchema>;

export const QuestSchema = z.strictObject({
  id: EntityIdSchema,
  title: text(80),
  status: QuestStatusSchema,
  notes: z.array(text(120)).max(50),
});
export type Quest = z.infer<typeof QuestSchema>;

export const ActSchema = z.strictObject({
  title: text(80),
  goal: text(300),
});
export type Act = z.infer<typeof ActSchema>;

export const PlotStageSchema = z.strictObject({
  id: StageIdSchema,
  title: text(60),
  goal: text(300),
});
export type PlotStage = z.infer<typeof PlotStageSchema>;

/** The campaign's plot plan: one pattern, one emotional arc, and the pattern's stages with campaign-specific goals. */
export const PlotSchema = z.strictObject({
  pattern: PlotPatternSchema,
  arc: PlotArcSchema,
  stages: z.array(PlotStageSchema).min(1).max(8),
});
export type Plot = z.infer<typeof PlotSchema>;

export const StoryBibleSchema = z.strictObject({
  title: text(80),
  digest: text(2000),
  tone: text(200),
  acts: z.array(ActSchema).max(10).optional(),
  /** Optional so older saves still parse. */
  plot: PlotSchema.optional(),
  milestones: z.array(MilestoneSchema).max(30),
  quests: z.array(QuestSchema).max(50),
});
export type StoryBible = z.infer<typeof StoryBibleSchema>;

export const NpcRecordSchema = z.strictObject({
  id: EntityIdSchema,
  name: text(40),
  concept: text(200),
  role: NpcRoleSchema,
  map_id: MapIdSchema,
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  sprite_tags: z.array(shortWord).max(5),
  appearance: AppearanceSchema.optional(),
  disposition: DispositionSchema.optional(),
  alive: z.boolean().default(true),
  /** Speech style, for example "clipped, nautical slang, never says no outright". */
  voice: text(80).optional(),
  /** The last few things the NPC said (the engine keeps `npc.linesKept`). */
  lines: z.array(text(120)).max(20).optional(),
  /** Short DM notes: promises, grudges, secrets known (the engine keeps `npc.notesKept`). */
  notes: z.array(text(120)).max(20).optional(),
  /** Beat counter (`GameState.turn`) when the NPC last appeared, spoke or got a note. */
  last_seen_beat: z.number().int().min(0).optional(),
  /** Combat stat block. Only `ally` NPCs have one; the engine derives it from the enemy table when the NPC is created. */
  stats: EnemyStatsSchema.optional(),
});
export type NpcRecord = z.infer<typeof NpcRecordSchema>;

/** An unresolved clue, mystery, promise, debt or looming danger the DM wants to pay off later. */
export const StoryThreadSchema = z.strictObject({
  id: EntityIdSchema,
  text: text(160),
  status: z.enum(["open", "closed"]),
  resolution: text(120).optional(),
});
export type StoryThread = z.infer<typeof StoryThreadSchema>;
