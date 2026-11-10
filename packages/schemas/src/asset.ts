import { z } from "zod";
import { MaterialSchema } from "./material";
import { SettingSpecSchema } from "./map";
import { SpriteSpecSchema } from "./sprite";

export const ASSET_KINDS = ["material", "setting", "sprite"] as const;
export const AssetKindSchema = z.enum(ASSET_KINDS);
export type AssetKind = z.infer<typeof AssetKindSchema>;

export const AssetIdSchema = z.string().trim().regex(/^as_[A-Za-z0-9_-]{1,60}$/, "asset id must start with as_");

const base = {
  id: AssetIdSchema,
  /** Hash of the normalized concept (lowercase, collapsed whitespace); the store's lookup key. */
  key: z.string().trim().min(1).max(128),
  created_at: z.iso.datetime(),
  /** How many times the store has handed this asset out. */
  uses: z.number().int().min(0),
};

/** Server-side asset store record (schema only for now). `spec` matches `kind`. */
export const AssetRecordSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...base, kind: z.literal("material"), spec: MaterialSchema }),
  z.strictObject({ ...base, kind: z.literal("setting"), spec: SettingSpecSchema }),
  z.strictObject({ ...base, kind: z.literal("sprite"), spec: SpriteSpecSchema }),
]);
export type AssetRecord = z.infer<typeof AssetRecordSchema>;
