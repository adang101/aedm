import { z } from "zod";
import { HexColorSchema, text } from "./common";

export const BODY_PLANS = ["humanoid", "beast", "avian", "serpent", "insectoid", "amorphous", "construct", "spirit", "plant", "object"] as const;
export const BodyPlanSchema = z.enum(BODY_PLANS);
export type BodyPlan = z.infer<typeof BodyPlanSchema>;

export const SPRITE_SIZES = ["tiny", "small", "medium", "large", "huge"] as const;
export const SpriteSizeSchema = z.enum(SPRITE_SIZES);
export type SpriteSize = z.infer<typeof SpriteSizeSchema>;

export const SPRITE_POSES = ["idle", "aggressive", "cowering", "floating"] as const;
export const SpritePoseSchema = z.enum(SPRITE_POSES);
export type SpritePose = z.infer<typeof SpritePoseSchema>;

/** Parts grouped by where they go. The renderer draws one small routine per part. */
export const PART_GROUPS = {
  head: ["horns", "antlers", "hood", "hat", "helmet", "crown", "mask", "halo", "beard", "long_hair", "ears_pointed", "glowing_eyes", "extra_eyes"],
  body: ["robe", "cloak", "armor", "scales", "fur", "shell", "spikes", "tentacles", "wings", "tail", "fins", "mane", "roots", "leaves", "gears", "crystals"],
  held: ["sword", "axe", "spear", "bow", "staff", "wand", "shield", "lantern", "book", "tool", "orb"],
  aura: ["aura", "smoke", "flames", "sparkles", "drips"],
} as const;
export type PartGroup = keyof typeof PART_GROUPS;

export const PART_CATALOG = [...PART_GROUPS.head, ...PART_GROUPS.body, ...PART_GROUPS.held, ...PART_GROUPS.aura] as const;
export const PartSchema = z.enum(PART_CATALOG);
export type Part = z.infer<typeof PartSchema>;

export function isPart(s: string): s is Part {
  return (PART_CATALOG as readonly string[]).includes(s);
}

export const PART_COLORS = ["primary", "secondary", "accent", "detail"] as const;
export const PartColorSchema = z.enum(PART_COLORS);
export type PartColor = z.infer<typeof PartColorSchema>;

export const PART_SIDES = ["left", "right", "both"] as const;
export const PartSideSchema = z.enum(PART_SIDES);
export type PartSide = z.infer<typeof PartSideSchema>;

export const MAX_SPRITE_PARTS = 6;

const glyph = z.string().trim().refine((s) => {
  const n = [...s].length;
  return n >= 1 && n <= 2;
}, { message: "glyph must be 1 to 2 characters" });

const paletteShape = {
  primary: HexColorSchema,
  secondary: HexColorSchema,
  accent: HexColorSchema,
  detail: HexColorSchema,
};
export const SpritePaletteSchema = z.strictObject(paletteShape);
export type SpritePalette = z.infer<typeof SpritePaletteSchema>;

const partFields = { color: PartColorSchema.optional(), side: PartSideSchema.optional() };

/** `image_asset_id` is where generated art plugs in later (M3). */
const specFields = {
  body: BodyPlanSchema,
  size: SpriteSizeSchema,
  glyph: glyph.optional(),
  pose: SpritePoseSchema.optional(),
  /** Image prompt traits. No names of real people, franchises or artists. */
  traits: text(160, 0),
  image_asset_id: z.string().trim().min(1).max(64).optional(),
};

/** The standard for every sprite (NPCs, enemies, characters, props). Colors are master palette colors. */
export const SpriteSpecSchema = z.strictObject({
  kind: z.literal("spec"),
  v: z.literal(1),
  ...specFields,
  palette: SpritePaletteSchema,
  parts: z.array(z.strictObject({ part: PartSchema, ...partFields })).max(MAX_SPRITE_PARTS),
});
export type SpriteSpec = z.infer<typeof SpriteSpecSchema>;

/**
 * What the sprite designer model returns. Colors are any `#rrggbb` (the engine snaps them) and `part`
 * is any short string: the engine drops names outside `PART_CATALOG`, keeps at most 6 parts and fills
 * a missing `size` / `traits` / `kind` / `v`. `body` stays strict; the engine falls back to "humanoid"
 * only through a repair call.
 */
export const SpriteSpecDraftSchema = z.strictObject({
  kind: z.literal("spec").optional(),
  v: z.literal(1).optional(),
  body: BodyPlanSchema,
  size: SpriteSizeSchema.default("medium"),
  glyph: glyph.optional(),
  pose: SpritePoseSchema.optional(),
  traits: text(160, 0).default(""),
  image_asset_id: z.string().trim().min(1).max(64).optional(),
  palette: z.strictObject(paletteShape),
  parts: z.array(z.strictObject({ part: z.string().trim().min(1).max(24), ...partFields })).max(12),
});
export type SpriteSpecDraft = z.infer<typeof SpriteSpecDraftSchema>;

/** Appearance hint on create_npc / create_enemy / NpcRecord / Enemy: input to the sprite designer. */
export const AppearanceSchema = text(160, 0);
