import { z } from "zod";
import {
  AbilityScoreKeySchema, AdvantageSchema, CheckTagSchema, ConditionSchema, DifficultySchema, DISPOSITIONS,
  EnemyRoleSchema, ItemKindSchema, NpcRoleSchema, QuestStatusSchema,
} from "./enums";
import { EnemyIdSchema, EntityIdSchema, MapIdSchema, countWords, maxWords, shortWord, text, wordRange } from "./common";
import { MapBriefSchema } from "./map";
import { StageIdSchema } from "./world";
import { AssetIdSchema } from "./asset";
import { AppearanceSchema } from "./sprite";

const coord = z.number().int().min(0).max(255);

export const RequestCheckActionSchema = z.strictObject({
  type: z.literal("request_check"),
  target: EntityIdSchema, // character id or "party"
  ability: AbilityScoreKeySchema,
  dc: z.number().int().min(0).max(99), // engine clamps to 5..30
  tags: z.array(CheckTagSchema).max(2),
  advantage: AdvantageSchema.default("none"),
  reason: text(120),
  /** Pre-written outcome per branch (1 to 60 words, flavor only). Optional so old replies parse. */
  on_success: wordRange(1, 60).optional(),
  on_failure: wordRange(1, 60).optional(),
});

export const CreateNpcActionSchema = z.strictObject({
  type: z.literal("create_npc"),
  name: text(40),
  concept: text(200),
  role: NpcRoleSchema,
  map_id: MapIdSchema,
  x: coord,
  y: coord,
  sprite_tags: z.array(shortWord).max(5),
  /** Optional look hint for the sprite designer (at most 160 chars). */
  appearance: AppearanceSchema.optional(),
  /** Optional approved cast asset id from the context pack. The look comes from the cast; stats and everything else stay with the engine. */
  asset_ref: AssetIdSchema.optional(),
});

export const NpcSayActionSchema = z.strictObject({
  type: z.literal("npc_say"),
  entity_id: EntityIdSchema,
  text: wordRange(1, 60),
});

export const CreateEnemyActionSchema = z.strictObject({
  type: z.literal("create_enemy"),
  concept: text(200),
  role: EnemyRoleSchema,
  setting_notes: text(200, 0).default(""),
  /** Optional look hint for the sprite designer (at most 160 chars). */
  appearance: AppearanceSchema.optional(),
  /** Optional handle (en_ + snake_case, at most 40 chars). The server registers the built archetype under it so spawn_entity can use it as archetype_id. */
  ref: z.string().trim().max(40).regex(/^en_[a-z0-9_]+$/, "ref must be en_ plus snake_case").optional(),
  /** Optional approved cast asset id from the context pack. The look comes from the cast; stats still come from the enemy builder and engine. */
  asset_ref: AssetIdSchema.optional(),
});

export const SpawnEntityActionSchema = z
  .strictObject({
    type: z.literal("spawn_entity"),
    archetype_id: EnemyIdSchema,
    map_id: MapIdSchema,
    x: coord.optional(),
    y: coord.optional(),
    slot_id: EntityIdSchema.optional(),
    count: z.number().int().min(1).max(6).default(1),
  })
  .superRefine((v, ctx) => {
    const hasXY = v.x !== undefined && v.y !== undefined;
    const partialXY = (v.x !== undefined) !== (v.y !== undefined);
    const hasSlot = v.slot_id !== undefined;
    if (partialXY || hasXY === hasSlot) {
      ctx.addIssue({ code: "custom", message: "provide either both x and y, or slot_id", path: ["slot_id"] });
    }
  });

export const StartCombatActionSchema = z.strictObject({
  type: z.literal("start_combat"),
  participants: z.array(EntityIdSchema).min(2).max(24),
  difficulty: DifficultySchema,
});

export const EndCombatActionSchema = z.strictObject({
  type: z.literal("end_combat"),
  reason: z.enum(["victory", "flee", "truce"]),
});

export const ApplyConditionActionSchema = z.strictObject({
  type: z.literal("apply_condition"),
  target: EntityIdSchema,
  condition: ConditionSchema,
  turns: z.number().int().min(1).max(3),
});

export const GrantItemActionSchema = z.strictObject({
  type: z.literal("grant_item"),
  recipient: EntityIdSchema,
  item: z.strictObject({
    name: text(40),
    kind: ItemKindSchema,
    value: z.number().int().min(0).max(100000),
    tier: z.number().int().min(1).max(5).optional(),
  }),
});

export const UpdateQuestActionSchema = z.strictObject({
  type: z.literal("update_quest"),
  quest_id: EntityIdSchema,
  status: QuestStatusSchema,
  note: text(120, 0).default(""),
});

export const SetFactActionSchema = z
  .strictObject({
    type: z.literal("set_fact"),
    subject: text(80),
    predicate: text(40),
    object: text(200),
  })
  .superRefine((v, ctx) => {
    if (v.predicate === "is_alive" && v.object !== "true" && v.object !== "false") {
      ctx.addIssue({ code: "custom", message: "is_alive must be true or false", path: ["object"] });
    }
    if (v.predicate === "disposition" && !(DISPOSITIONS as readonly string[]).includes(v.object)) {
      ctx.addIssue({ code: "custom", message: `disposition must be one of ${DISPOSITIONS.join(", ")}`, path: ["object"] });
    }
  });

export const GenerateMapActionSchema = z.strictObject({
  type: z.literal("generate_map"),
  brief: MapBriefSchema,
});

export const ChangeSceneActionSchema = z.strictObject({
  type: z.literal("change_scene"),
  map_id: MapIdSchema,
  entry: text(32),
});

export const AwardGrowthActionSchema = z.strictObject({
  type: z.literal("award_growth"),
  character_id: EntityIdSchema,
  amount: z.number().int().min(1).max(25),
  reason: text(120),
});

export const CompleteMilestoneActionSchema = z.strictObject({
  type: z.literal("complete_milestone"),
  milestone_id: EntityIdSchema,
});

/** Re-plans stages that have not started: new goals and a fresh milestone list for each. */
export const AdjustPlotActionSchema = z.strictObject({
  type: z.literal("adjust_plot"),
  stages: z.array(z.strictObject({
    stage_id: StageIdSchema,
    goal: text(300),
    milestones: z.array(z.strictObject({ id: EntityIdSchema, description: text(300) })).min(1).max(4),
  })).min(1).max(7),
});

export const SuggestActionsActionSchema = z.strictObject({
  type: z.literal("suggest_actions"),
  chips: z.array(text(60).refine((s) => countWords(s) <= 4, { message: "at most 4 words" })).min(2).max(4),
});

export const DmActionSchema = z.discriminatedUnion("type", [
  RequestCheckActionSchema, CreateNpcActionSchema, NpcSayActionSchema, CreateEnemyActionSchema,
  SpawnEntityActionSchema, StartCombatActionSchema, EndCombatActionSchema, ApplyConditionActionSchema,
  GrantItemActionSchema, UpdateQuestActionSchema, SetFactActionSchema, GenerateMapActionSchema,
  ChangeSceneActionSchema, AwardGrowthActionSchema, CompleteMilestoneActionSchema, AdjustPlotActionSchema, SuggestActionsActionSchema,
]);
export type DmAction = z.infer<typeof DmActionSchema>;
export type DmActionType = DmAction["type"];
export const DM_ACTION_TYPES = DmActionSchema.options.map((o) => o.shape.type.value) as DmActionType[];

const narration = wordRange(40, 150).refine((s) => !/<\/?[a-zA-Z][^>]*>/.test(s), {
  message: "narration must be plain text without HTML",
});

export const DmResponseSchema = z.strictObject({
  v: z.literal(1),
  narration,
  actions: z.array(DmActionSchema).max(8),
  dm_notes: maxWords(100).optional(),
  importance: z.number().int().min(1).max(5),
  high_stakes: z.boolean().default(false),
});
export type DmResponse = z.infer<typeof DmResponseSchema>;

/**
 * Shape-only parse so the pipeline can salvage valid actions one by one with DmActionSchema.
 * Unknown top-level fields are tolerated here.
 */
export const DmResponseLooseSchema = z.looseObject({
  narration: z.string(),
  actions: z.array(z.unknown()),
});
export type DmResponseLoose = z.infer<typeof DmResponseLooseSchema>;
