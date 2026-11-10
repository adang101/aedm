import { z } from "zod";
import { DamageTypeSchema } from "./enums";
import { DiceSchema, HexColorSchema, shortWord, text } from "./common";

export const MATERIAL_ROLES = ["floor", "path", "wall", "obstacle", "liquid", "hazard", "decor", "door"] as const;
export const MaterialRoleSchema = z.enum(MATERIAL_ROLES);
export type MaterialRole = z.infer<typeof MaterialRoleSchema>;

/** Patterns the renderer can draw with a small canvas routine each. "none" is a flat fill. */
export const PATTERNS = [
  "none", "dots", "stripes", "cross", "bricks", "planks", "cobbles", "tiles", "waves", "cracks",
  "grain", "grass", "sand", "speckle", "rings", "scales", "runes", "glow", "lattice",
] as const;
export const PatternSchema = z.enum(PATTERNS);
export type Pattern = z.infer<typeof PatternSchema>;

export const MATERIAL_ID_RX = /^[a-z][a-z0-9_]{0,31}$/;
/** snake_case, starts with a letter, at most 32 characters. */
export const MaterialIdSchema = z.string().trim().regex(MATERIAL_ID_RX, "material id must be snake_case, at most 32 characters");

/** What each role means for movement and sight unless a material says otherwise. */
export const ROLE_DEFAULTS: Readonly<Record<MaterialRole, { walkable: boolean; blocks_sight: boolean }>> = {
  floor: { walkable: true, blocks_sight: false },
  path: { walkable: true, blocks_sight: false },
  wall: { walkable: false, blocks_sight: true },
  obstacle: { walkable: false, blocks_sight: false },
  liquid: { walkable: false, blocks_sight: false },
  hazard: { walkable: true, blocks_sight: false },
  decor: { walkable: true, blocks_sight: false },
  door: { walkable: true, blocks_sight: false },
};

export const MaterialHazardSchema = z.strictObject({ damage_type: DamageTypeSchema, dice: DiceSchema });
export type MaterialHazard = z.infer<typeof MaterialHazardSchema>;

const tags = z.array(shortWord).max(6);

function hazardOnlyOnHazardRole(m: { role: string; hazard?: unknown }, ctx: z.RefinementCtx): void {
  if (m.hazard !== undefined && m.role !== "hazard") {
    ctx.addIssue({ code: "custom", message: "hazard is only allowed on materials with role hazard", path: ["hazard"] });
  }
}

/** A material as the engine stores and the client draws it. Colors are master palette colors. */
export const MaterialSchema = z
  .strictObject({
    id: MaterialIdSchema,
    name: text(40),
    role: MaterialRoleSchema,
    color: HexColorSchema,
    accent: HexColorSchema,
    pattern: PatternSchema,
    walkable: z.boolean(),
    blocks_sight: z.boolean(),
    hazard: MaterialHazardSchema.optional(),
    tags,
    prompt_traits: text(120, 0),
  })
  .superRefine(hazardOnlyOnHazardRole);
export type Material = z.infer<typeof MaterialSchema>;

/**
 * A material the DM defines inline in a map brief. Lenient on purpose: colors are any `#rrggbb` (the
 * engine snaps them to the palette), `pattern` is any short word (the engine picks the closest allowed
 * pattern, else "none"), and walkable / blocks_sight default by role (`ROLE_DEFAULTS`). The engine
 * derives a missing `id` from `name`, and a missing `accent` from `color`.
 */
export const MaterialDraftSchema = z
  .strictObject({
    id: MaterialIdSchema.optional(),
    name: text(40),
    role: MaterialRoleSchema,
    color: HexColorSchema,
    accent: HexColorSchema.optional(),
    pattern: z.string().trim().min(1).max(24).optional(),
    walkable: z.boolean().optional(),
    blocks_sight: z.boolean().optional(),
    hazard: MaterialHazardSchema.optional(),
    tags: tags.default([]),
    prompt_traits: text(120, 0).default(""),
  })
  .superRefine(hazardOnlyOnHazardRole);
export type MaterialDraft = z.infer<typeof MaterialDraftSchema>;

/** Fills walkable and blocks_sight from the role when the draft omits them. Pure; colors are not snapped here. */
export function materialDefaults(draft: Pick<MaterialDraft, "role" | "walkable" | "blocks_sight">): { walkable: boolean; blocks_sight: boolean } {
  const d = ROLE_DEFAULTS[draft.role];
  return { walkable: draft.walkable ?? d.walkable, blocks_sight: draft.blocks_sight ?? d.blocks_sight };
}

/** A brief refers to a material by library id or defines one inline. */
export const MaterialRefSchema = z.union([MaterialIdSchema, MaterialDraftSchema]);
export type MaterialRef = z.infer<typeof MaterialRefSchema>;
