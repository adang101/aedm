import { z } from "zod";
import {
  AbilityActionSchema, AbilityScoreKeySchema, AbilityTargetSchema, AffectsSchema, CheckTagSchema,
  ConditionSchema, ConditionTriggerSchema, DamageTypeSchema, EffectShapeSchema, OnSaveSchema,
  TerrainKindSchema, TerrainShapeSchema,
} from "./enums";
import { AbilityIdSchema, DiceSchema, text } from "./common";

const turns13 = z.number().int().min(1).max(3);
const affects = { affects: AffectsSchema.optional() };

/** Save made by targets; the DC is always the caster's save DC. */
export const SaveSchema = z.strictObject({
  ability: AbilityScoreKeySchema,
  dc: z.literal("caster_dc"),
});
export type Save = z.infer<typeof SaveSchema>;

type ShapeFields = {
  shape: string;
  radius_tiles?: number | undefined;
  length_tiles?: number | undefined;
};

/** Structural shape checks shared by damage, heal and terrain effects. */
function checkShape(v: ShapeFields, ctx: z.RefinementCtx): void {
  const bad = (message: string, path: string) => ctx.addIssue({ code: "custom", message, path: [path] });
  const radiusShapes = ["burst"];
  const lengthShapes = ["line", "cone"];
  if (radiusShapes.includes(v.shape)) {
    if (v.radius_tiles === undefined) bad("burst needs radius_tiles", "radius_tiles");
    if (v.length_tiles !== undefined) bad("burst does not take length_tiles", "length_tiles");
  } else if (lengthShapes.includes(v.shape)) {
    if (v.length_tiles === undefined) bad(`${v.shape} needs length_tiles`, "length_tiles");
    else if (v.shape === "cone" && v.length_tiles > 4) bad("cone length is at most 4", "length_tiles");
    if (v.radius_tiles !== undefined) bad(`${v.shape} does not take radius_tiles`, "radius_tiles");
  } else {
    if (v.radius_tiles !== undefined) bad("radius_tiles not allowed for this shape", "radius_tiles");
    if (v.length_tiles !== undefined) bad("length_tiles not allowed for this shape", "length_tiles");
  }
}

const radius12 = z.number().int().min(1).max(2);
const length16 = z.number().int().min(1).max(6);

export const DamageEffectSchema = z
  .strictObject({
    type: z.literal("damage"),
    shape: EffectShapeSchema,
    radius_tiles: radius12.optional(),
    length_tiles: length16.optional(),
    dice: DiceSchema,
    damage_type: DamageTypeSchema,
    save: SaveSchema.optional(),
    on_save: OnSaveSchema.optional(),
    ...affects,
  })
  .superRefine((v, ctx) => {
    checkShape(v, ctx);
    if (v.on_save !== undefined && v.save === undefined) {
      ctx.addIssue({ code: "custom", message: "on_save requires save", path: ["on_save"] });
    }
    if (v.save !== undefined && v.on_save === undefined) {
      ctx.addIssue({ code: "custom", message: "save requires on_save (half or none)", path: ["on_save"] });
    }
  });

export const HealEffectSchema = z
  .strictObject({
    type: z.literal("heal"),
    shape: z.enum(["single", "burst"]),
    radius_tiles: radius12.optional(),
    dice: DiceSchema,
    ...affects,
  })
  .superRefine((v, ctx) => checkShape(v, ctx));

export const ShieldEffectSchema = z.strictObject({
  type: z.literal("shield"),
  absorb: z.number().int().min(1).max(40),
  duration_turns: turns13,
  ...affects,
});

export const ConditionEffectSchema = z.strictObject({
  type: z.literal("condition"),
  condition: ConditionSchema,
  duration_turns: turns13,
  on: ConditionTriggerSchema,
  save: SaveSchema.optional(),
  ...affects,
});

export const PushEffectSchema = z.strictObject({ type: z.literal("push"), tiles: z.number().int().min(1).max(4), ...affects });
export const PullEffectSchema = z.strictObject({ type: z.literal("pull"), tiles: z.number().int().min(1).max(4), ...affects });
export const DashEffectSchema = z.strictObject({
  type: z.literal("dash"),
  tiles: z.number().int().min(1).max(8),
  with_attack: z.boolean(),
  ...affects,
});
export const TeleportEffectSchema = z.strictObject({ type: z.literal("teleport"), tiles: z.number().int().min(1).max(6), ...affects });
export const MarkEffectSchema = z.strictObject({ type: z.literal("mark"), duration_turns: turns13, ...affects });
export const RevealEffectSchema = z.strictObject({ type: z.literal("reveal"), radius_tiles: radius12, ...affects });
export const DisarmEffectSchema = z.strictObject({ type: z.literal("disarm"), ...affects });

export const TerrainEffectSchema = z
  .strictObject({
    type: z.literal("terrain"),
    kind: TerrainKindSchema,
    shape: TerrainShapeSchema,
    radius_tiles: radius12.optional(),
    length_tiles: length16.optional(),
    duration_turns: turns13.optional(),
    dice: DiceSchema.optional(),
    damage_type: DamageTypeSchema.optional(),
    ...affects,
  })
  .superRefine((v, ctx) => {
    checkShape(v, ctx);
    const dmgOk = v.kind === "fire" || v.kind === "trap";
    if (!dmgOk && (v.dice !== undefined || v.damage_type !== undefined)) {
      ctx.addIssue({ code: "custom", message: "dice and damage_type only for fire and trap terrain", path: ["dice"] });
    }
    if ((v.dice === undefined) !== (v.damage_type === undefined)) {
      ctx.addIssue({ code: "custom", message: "dice and damage_type go together", path: ["damage_type"] });
    }
  });

export const CheckBonusEffectSchema = z.strictObject({
  type: z.literal("check_bonus"),
  bonus: z.number().int().min(1).max(4),
  tags: z.array(CheckTagSchema).min(1).max(2),
  duration_turns: turns13,
  ...affects,
});

export const EffectSchema = z.discriminatedUnion("type", [
  DamageEffectSchema, HealEffectSchema, ShieldEffectSchema, ConditionEffectSchema,
  PushEffectSchema, PullEffectSchema, DashEffectSchema, TeleportEffectSchema,
  MarkEffectSchema, RevealEffectSchema, DisarmEffectSchema, TerrainEffectSchema,
  CheckBonusEffectSchema,
]);
export type Effect = z.infer<typeof EffectSchema>;
export type DamageEffect = z.infer<typeof DamageEffectSchema>;
export type HealEffect = z.infer<typeof HealEffectSchema>;
export type ConditionEffect = z.infer<typeof ConditionEffectSchema>;
export type TerrainEffect = z.infer<typeof TerrainEffectSchema>;

const abilityFields = {
  name: text(40),
  description: text(200),
  tags: z.array(CheckTagSchema).max(2).default([]),
  action: AbilityActionSchema,
  target: AbilityTargetSchema,
  range_tiles: z.number().int().min(0).max(12),
  effects: z.array(EffectSchema).min(1).max(4),
  cooldown_turns: z.number().int().min(0).max(6).optional(),
  uses_per_rest: z.number().int().min(1).max(3).optional(),
  forge_notes: text(200, 0).optional(),
};

type FrequencyFields = { cooldown_turns?: number | undefined; uses_per_rest?: number | undefined };
function checkFrequency(v: FrequencyFields, ctx: z.RefinementCtx): void {
  const hasCd = v.cooldown_turns !== undefined;
  const hasUses = v.uses_per_rest !== undefined;
  if (hasCd === hasUses) {
    ctx.addIssue({
      code: "custom",
      message: "exactly one of cooldown_turns and uses_per_rest must be present",
      path: [hasCd ? "uses_per_rest" : "cooldown_turns"],
    });
  }
}

/** A full ability. `id` and `cost` are optional on input: the engine assigns the id and recomputes cost. */
export const AbilitySchema = z
  .strictObject({
    v: z.literal(1),
    id: AbilityIdSchema.optional(),
    ...abilityFields,
    cost: z.number().int().min(0).optional(),
  })
  .superRefine(checkFrequency);
export type Ability = z.infer<typeof AbilitySchema>;

/**
 * What the ability forge model returns. `v`, `id` and `cost` are all optional and any `cost` is
 * ignored (the engine recomputes it). Everything else is as strict as Ability.
 */
export const AbilityDraftSchema = z
  .strictObject({
    v: z.literal(1).optional(),
    id: z.string().optional(),
    ...abilityFields,
    cost: z.unknown().optional(),
  })
  .superRefine(checkFrequency);
export type AbilityDraft = z.infer<typeof AbilityDraftSchema>;
