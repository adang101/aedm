import { z } from "zod";
import { EnemyRoleSchema, NpcRoleSchema, SizeClassSchema } from "./enums";
import { EntityIdSchema, StageIdSchema, shortWord, text } from "./common";
import { SettingSchema } from "./map";

/**
 * The campaign plan: the engine-ready part of the story bible (places, cast, encounters, key items, an ending) and the
 * machine-checkable milestone triggers. All of it is optional on the bible, so saves from before the plan still parse.
 * Plan ids are free ids (`EntityIdSchema`); they only have to be unique within their own list and are never reused as
 * runtime ids (the engine binds each plan id to a map, NPC, spawned creature or item when it builds the content).
 * Stats never appear here: the enemy builder and the threat rules decide every number.
 */

/** Most connections one location may have (the map brief allows at most 4 exits). */
export const MAX_LOCATION_CONNECTIONS = 4;

/** A place in the campaign. Its map is built from `setting` (plus tags, size and features) by the existing map generator. */
export const PlanLocationSchema = z.strictObject({
  id: EntityIdSchema,
  name: text(40),
  summary: text(200),
  /** The plot stage this location belongs to (its story weight; any location can be visited at any time). */
  stage: StageIdSchema,
  /** Ids of the locations this one leads to. A connection works both ways; one side declaring it is enough. */
  connects_to: z.array(EntityIdSchema).max(MAX_LOCATION_CONNECTIONS),
  /** The same open-ended setting a map brief carries (`layout`, `environment` and `mood` are required). */
  setting: SettingSchema,
  theme_tags: z.array(shortWord).max(4).optional(),
  size_class: SizeClassSchema.optional(),
  /** Points of interest, as `PointOfInterestSchema.kind` (for example "altar", "well"). The engine picks the rooms. */
  features: z.array(text(24)).max(4).optional(),
});
export type PlanLocation = z.infer<typeof PlanLocationSchema>;

/** A named NPC who lives at a location. The engine creates the NPC when that location's map is added. */
export const CastMemberSchema = z.strictObject({
  id: EntityIdSchema,
  name: text(40),
  concept: text(200),
  role: NpcRoleSchema,
  /** Home location id. */
  location: EntityIdSchema,
  voice: text(80).optional(),
});
export type CastMember = z.infer<typeof CastMemberSchema>;

export const EnemyGroupSchema = z.strictObject({
  /** What the enemy builder is asked to make, for example "a cultist who borrows the voices of the drowned". */
  concept: text(200),
  role: EnemyRoleSchema,
  count: z.number().int().min(1).max(6),
});
export type EnemyGroup = z.infer<typeof EnemyGroupSchema>;

/** A planned fight. The engine spawns its creatures when the location's map is added, from archetypes the server builds. */
export const PlanEncounterSchema = z.strictObject({
  id: EntityIdSchema,
  /** Short player-facing name, for example "Choir sentries". Used to word objectives. */
  name: text(40),
  location: EntityIdSchema,
  stage: StageIdSchema,
  groups: z.array(EnemyGroupSchema).min(1).max(3),
});
export type PlanEncounter = z.infer<typeof PlanEncounterSchema>;

/** Who or what carries a key item: a cast member (their pockets) or an encounter (its toughest creature, dropped on defeat). */
export const KeyItemHolderSchema = z.strictObject({
  kind: z.enum(["cast", "encounter"]),
  id: EntityIdSchema,
});
export type KeyItemHolder = z.infer<typeof KeyItemHolderSchema>;

/** A story item (kind `quest`, no value). The engine places it when its location's map is added. */
export const KeyItemSchema = z.strictObject({
  id: EntityIdSchema,
  name: text(40),
  /** Where it is found. A holder must be at the same location. */
  location: EntityIdSchema,
  held_by: KeyItemHolderSchema.optional(),
});
export type KeyItem = z.infer<typeof KeyItemSchema>;

export const EndingSchema = z.strictObject({
  /** The final goal, as the DM sees it. */
  goal: text(200),
  success: text(200),
  failure: text(200),
});
export type Ending = z.infer<typeof EndingSchema>;

/**
 * What completes a milestone. `story` (the default when `trigger` is absent) is judged by the DM with `complete_milestone`;
 * the other four are tracked by the engine and the DM may not complete them.
 */
export const MilestoneTriggerSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("reach_location"), location: EntityIdSchema }),
  z.strictObject({ type: z.literal("defeat_encounter"), encounter: EntityIdSchema }),
  z.strictObject({ type: z.literal("obtain_item"), item: EntityIdSchema }),
  z.strictObject({ type: z.literal("talk_to"), cast: EntityIdSchema }),
  z.strictObject({ type: z.literal("story") }),
]);
export type MilestoneTrigger = z.infer<typeof MilestoneTriggerSchema>;

/** Longest player-facing hint. */
export const HINT_MAX = 100;

// ---------- the player-facing objective view (wire) ----------

export const ObjectiveMilestoneSchema = z.strictObject({
  id: EntityIdSchema,
  hint: text(HINT_MAX),
  done: z.boolean(),
});
export type ObjectiveMilestone = z.infer<typeof ObjectiveMilestoneSchema>;

/**
 * What players see of the story's progress: the current stage and its milestones only (never later stages, never triggers).
 * `progress` counts every milestone of the campaign.
 */
export const ObjectiveViewSchema = z.strictObject({
  stage: z.strictObject({
    id: StageIdSchema,
    /** Zero-based. */
    index: z.number().int().min(0).max(7),
    count: z.number().int().min(1).max(8),
    title: text(60),
    goal: text(300),
  }),
  milestones: z.array(ObjectiveMilestoneSchema).max(30),
  progress: z.strictObject({ done: z.number().int().min(0).max(30), total: z.number().int().min(0).max(30) }),
  finished: z.boolean(),
});
export type ObjectiveView = z.infer<typeof ObjectiveViewSchema>;

/** Payload of the `objective_update` server message: the new view, plus the milestones that were just completed. */
export const ObjectiveUpdatePayload = ObjectiveViewSchema.extend({
  completed: z.array(ObjectiveMilestoneSchema).max(30).optional(),
});
export type ObjectiveUpdate = z.infer<typeof ObjectiveUpdatePayload>;
