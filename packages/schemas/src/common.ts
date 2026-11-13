import { z } from "zod";

/** Trimmed string with a length range in characters. */
export const text = (max: number, min = 1) => z.string().trim().min(min).max(max);

/** Count whitespace-separated words. */
export function countWords(s: string): number {
  const t = s.trim();
  return t === "" ? 0 : t.split(/\s+/).length;
}

/** Trimmed string with at most `n` words (empty allowed). */
export const maxWords = (n: number) =>
  z.string().trim().refine((s) => countWords(s) <= n, { message: `must be at most ${n} words` });

/** Trimmed string with between `min` and `max` words. */
export const wordRange = (min: number, max: number) =>
  z.string().trim().refine((s) => {
    const c = countWords(s);
    return c >= min && c <= max;
  }, { message: `must be ${min} to ${max} words` });

/** Short lowercase-ish word used for tags (sprite_tags, theme_tags). */
export const shortWord = z.string().trim().min(1).max(24);

/** Dice string NdM: N 1-8, M in 4,6,8,10,12. */
export const DICE_SIDES = [4, 6, 8, 10, 12] as const;
export const DiceSchema = z.string().trim().regex(/^[1-8]d(4|6|8|10|12)$/, "dice must be NdM, N 1-8, M one of 4,6,8,10,12");
export type Dice = z.infer<typeof DiceSchema>;

export function parseDice(s: string): { count: number; sides: number } {
  const m = /^([1-8])d(4|6|8|10|12)$/.exec(s.trim());
  if (!m) throw new Error(`invalid dice string: ${s}`);
  return { count: Number(m[1]), sides: Number(m[2]) };
}

const idChars = /^[A-Za-z0-9_.:-]+$/;

/** Free entity / record id (characters, NPCs, quests, interactables, slots...). */
export const EntityIdSchema = z.string().trim().min(1).max(64).regex(idChars, "invalid id");
export const AbilityIdSchema = z.string().trim().regex(/^ab_[A-Za-z0-9_-]{1,60}$/, "ability id must start with ab_");
export const EnemyIdSchema = z.string().trim().regex(/^en_[A-Za-z0-9_-]{1,60}$/, "enemy id must start with en_");
export const MapIdSchema = z.string().trim().regex(/^m_[A-Za-z0-9_-]{1,60}$/, "map id must start with m_");

export const TileCoord = z.number().int().min(0).max(255);

export const HexColorSchema = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "color must be #rrggbb");

/** Combat numbers of an enemy archetype, or of an allied NPC. */
export const EnemyStatsSchema = z.strictObject({
  hp: z.number().int().min(1).max(500),
  defense: z.number().int().min(5).max(30),
  attack_bonus: z.number().int().min(-2).max(15),
  speed: z.number().int().min(1).max(12),
  damage_dice: DiceSchema,
});
export type EnemyStats = z.infer<typeof EnemyStatsSchema>;
