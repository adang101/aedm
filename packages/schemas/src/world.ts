import { z } from "zod";
import {
  ContentRatingSchema, DispositionSchema, ItemKindSchema, NpcRoleSchema, QuestStatusSchema,
} from "./enums";
import { EntityIdSchema, MapIdSchema, shortWord, text } from "./common";

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

export const MilestoneSchema = z.strictObject({
  id: EntityIdSchema,
  description: text(300),
  completed: z.boolean(),
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

export const StoryBibleSchema = z.strictObject({
  title: text(80),
  digest: text(2000),
  tone: text(200),
  acts: z.array(ActSchema).max(10).optional(),
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
  disposition: DispositionSchema.optional(),
  alive: z.boolean().default(true),
});
export type NpcRecord = z.infer<typeof NpcRecordSchema>;
