import { z } from "zod";
import { HexColorSchema, text } from "./common";
import { SpriteSizeSchema, SpriteSpecSchema } from "./sprite";

export const PIXEL_WIDTH = 48;
export const PIXEL_HEIGHT = 64;
export const PIXEL_COUNT = PIXEL_WIDTH * PIXEL_HEIGHT;
export const MAX_PIXEL_COLORS = 32;
/** Upper bound on the encoded string; the engine applies the tighter whole-recipe byte limit. */
export const MAX_PIXEL_STRING = 6144;

/**
 * Player-painted sprite: 48 x 64 palette indices (0 is transparent, i is `palette[i - 1]`), run-length
 * encoded (see `encodePixels`). Palette colors must be master palette colors; the engine checks that.
 */
export const PixelSpriteSchema = z.strictObject({
  kind: z.literal("pixel"),
  v: z.literal(1),
  width: z.literal(PIXEL_WIDTH),
  height: z.literal(PIXEL_HEIGHT),
  palette: z.array(HexColorSchema).min(1).max(MAX_PIXEL_COLORS),
  pixels: z.string().min(1).max(MAX_PIXEL_STRING).regex(/^(?:[.A-Za-f]\d*)+$/, "malformed pixel data"),
  size: SpriteSizeSchema,
  /** The spec this was painted over (traits, fallback drawing, image model input). */
  base: SpriteSpecSchema.optional(),
  traits: text(160, 0),
});
export type PixelSprite = z.infer<typeof PixelSpriteSchema>;

/** Run symbols: "." is index 0 (transparent), then A to Z and a to f for indices 1 to 32. */
const SYMBOLS = ".ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef";

/** Runs are a symbol followed by a decimal count (omitted when 1). */
export function encodePixels(indices: ArrayLike<number>): string {
  let out = "";
  let i = 0;
  while (i < indices.length) {
    const v = indices[i]!;
    const sym = SYMBOLS[v];
    if (sym === undefined || !Number.isInteger(v)) throw new Error(`pixel index out of range: ${v}`);
    let n = 1;
    while (i + n < indices.length && indices[i + n] === v) n++;
    out += n === 1 ? sym : `${sym}${n}`;
    i += n;
  }
  return out;
}

/** Decodes to exactly `expected` indices, or returns undefined when the string is malformed or the wrong length. */
export function decodePixels(s: string, expected: number = PIXEL_COUNT): Uint8Array | undefined {
  const out = new Uint8Array(expected);
  const re = /([.A-Za-f])(\d*)/y;
  let pos = 0;
  let at = 0;
  while (pos < s.length) {
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m) return undefined;
    const n = m[2] === "" ? 1 : Number(m[2]);
    if (!Number.isSafeInteger(n) || n < 1 || at + n > expected) return undefined;
    out.fill(SYMBOLS.indexOf(m[1]!), at, at + n);
    at += n;
    pos = re.lastIndex;
  }
  return at === expected ? out : undefined;
}
