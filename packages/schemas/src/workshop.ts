import { z } from "zod";
import { AssetIdSchema } from "./asset";
import { SpriteRecipeSchema } from "./character";
import { shortWord, text } from "./common";

/** Per-account Workshop limits (see docs/design.md "Player-made sprites"). */
export const WORKSHOP_MAX_ASSETS = 200;
export const WORKSHOP_MAX_BYTES = 5 * 1024 * 1024;

export const SPRITE_ROLE_HINTS = ["pc", "npc", "enemy", "prop"] as const;
export const SpriteRoleHintSchema = z.enum(SPRITE_ROLE_HINTS);
export type SpriteRoleHint = z.infer<typeof SpriteRoleHintSchema>;

export const SPRITE_ASSET_SOURCES = ["designed", "painted_over", "painted"] as const;
export const SpriteAssetSourceSchema = z.enum(SPRITE_ASSET_SOURCES);
export type SpriteAssetSource = z.infer<typeof SpriteAssetSourceSchema>;

/** Room setting: whether (and how) players may offer Workshop sprites to the campaign cast. */
export const CUSTOM_CAST_MODES = ["off", "host_approval", "open"] as const;
export const CustomCastSchema = z.enum(CUSTOM_CAST_MODES);
export type CustomCast = z.infer<typeof CustomCastSchema>;

const assetFields = {
  name: text(40),
  role_hint: SpriteRoleHintSchema,
  concept: text(200, 0),
  tags: z.array(shortWord).max(5).default([]),
  recipe: SpriteRecipeSchema,
  source: SpriteAssetSourceSchema,
};

/** Painted sources need a pixel recipe; a designed one must not be a pixel recipe. */
const sourceMatchesRecipe = (v: { recipe: { kind: string }; source: string }) => (v.source === "designed") === (v.recipe.kind !== "pixel");
const sourceMessage = { message: "source must be designed for shape and spec recipes, and painted or painted_over for pixel recipes", path: ["source"] };

/** A Workshop asset as clients see it (the owner id never leaves the server). */
export const WorkshopAssetSchema = z.strictObject({
  id: AssetIdSchema,
  ...assetFields,
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
}).refine(sourceMatchesRecipe, sourceMessage);
export type WorkshopAsset = z.infer<typeof WorkshopAssetSchema>;

/** What the server stores per account. */
export const WorkshopAssetRecordSchema = z.strictObject({
  id: AssetIdSchema,
  owner_user_id: z.string().trim().min(1).max(64),
  ...assetFields,
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
}).refine(sourceMatchesRecipe, sourceMessage);
export type WorkshopAssetRecord = z.infer<typeof WorkshopAssetRecordSchema>;

/** `id` set: update that asset (the owner's own). Absent: create a new one. */
export const SaveSpriteAssetPayload = z.strictObject({
  id: AssetIdSchema.optional(),
  ...assetFields,
}).refine(sourceMatchesRecipe, sourceMessage);
export const DeleteSpriteAssetPayload = z.strictObject({ id: AssetIdSchema });
export const ListSpriteAssetsPayload = z.strictObject({});
/** The reply to list, save and delete (ack_id set when it answers a request). */
export const SpriteAssetsListPayload = z.strictObject({
  assets: z.array(WorkshopAssetSchema).max(WORKSHOP_MAX_ASSETS),
  used_bytes: z.number().int().min(0),
  max_assets: z.number().int().min(1),
  max_bytes: z.number().int().min(1),
});

// ---------- campaign cast ----------

export const CAST_STATUSES = ["pending", "approved"] as const;
export const CastEntrySchema = z.strictObject({
  asset_id: AssetIdSchema,
  owner_player_id: z.string().trim().min(1).max(64),
  owner_name: text(24),
  name: text(40),
  role_hint: SpriteRoleHintSchema,
  concept: text(200, 0),
  recipe: SpriteRecipeSchema,
  status: z.enum(CAST_STATUSES),
});
export type CastEntry = z.infer<typeof CastEntrySchema>;
export const MAX_CAST_ENTRIES = 60;

export const OfferToCastPayload = z.strictObject({ asset_id: AssetIdSchema });
/** Host: approve or deny a pending entry, or remove an approved one (approve false). The offering player may also withdraw their own entry. */
export const CastDecisionPayload = z.strictObject({ asset_id: AssetIdSchema, approve: z.boolean() });
export const CastStatePayload = z.strictObject({ entries: z.array(CastEntrySchema).max(MAX_CAST_ENTRIES) });
