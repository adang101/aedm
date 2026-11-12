import { PIXEL_COUNT, PIXEL_HEIGHT, PIXEL_WIDTH, decodePixels, encodePixels, inPalette, type PixelSprite } from "@aedm/schemas";
import { PIXEL_RULES } from "./data.ts";

export type PixelErrorCode = "size" | "index" | "palette" | "colors" | "opaque" | "margin" | "feet" | "bytes";
export interface PixelIssue { code: PixelErrorCode; message: string }
export type PixelValidation = { ok: true; opaque: number; feet: number } | { ok: false; errors: PixelIssue[] };

const byteLength = (s: string): number => new TextEncoder().encode(s).length;

/** Lowest opaque row, or -1 for a blank or undecodable sprite. */
export function feetRow(s: PixelSprite): number {
  const px = decodePixels(s.pixels);
  if (!px) return -1;
  for (let y = PIXEL_HEIGHT - 1; y >= 0; y--) for (let x = 0; x < PIXEL_WIDTH; x++) if (px[y * PIXEL_WIDTH + x]) return y;
  return -1;
}

/**
 * Checks a painted sprite against the style rules. Pure; reports every problem found.
 * The recipe byte limit keeps the whole create message under the 8 KB frame limit.
 */
export function validatePixelSprite(s: PixelSprite): PixelValidation {
  const R = PIXEL_RULES;
  const errors: PixelIssue[] = [];
  const add = (code: PixelErrorCode, message: string) => errors.push({ code, message });

  if (s.width !== PIXEL_WIDTH || s.height !== PIXEL_HEIGHT) add("size", `The canvas must be ${PIXEL_WIDTH} x ${PIXEL_HEIGHT} pixels.`);
  if (s.palette.length > R.maxColors) add("colors", `Use at most ${R.maxColors} colors (this has ${s.palette.length}).`);
  const off = s.palette.filter((c) => !inPalette(c));
  if (off.length > 0) add("palette", `Every color must come from the master palette (not ${off[0]}).`);

  const px = decodePixels(s.pixels, PIXEL_COUNT);
  if (!px) {
    add("size", "The pixel data does not describe a 48 x 64 image.");
  } else {
    let opaque = 0, maxIdx = 0, minX = PIXEL_WIDTH, maxX = -1, minY = PIXEL_HEIGHT, maxY = -1;
    for (let i = 0; i < px.length; i++) {
      const v = px[i]!;
      if (v === 0) continue;
      opaque++;
      if (v > maxIdx) maxIdx = v;
      const x = i % PIXEL_WIDTH, y = (i / PIXEL_WIDTH) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (maxIdx > s.palette.length) add("index", "A pixel uses a color that is not in the palette.");
    if (opaque < R.minOpaque) add("opaque", `Paint at least ${R.minOpaque} pixels (this has ${opaque}).`);
    if (opaque > 0) {
      const m = R.margin;
      if (minX < m || minY < m || maxX > PIXEL_WIDTH - 1 - m || maxY > PIXEL_HEIGHT - 1 - m) {
        add("margin", `Keep ${m} pixels of empty space around the edge of the canvas.`);
      }
      if (Math.abs(maxY - R.feetY) > R.feetTolerance) {
        add("feet", `The feet (lowest pixel, row ${maxY}) should be near row ${R.feetY}, within ${R.feetTolerance}.`);
      }
    }
    if (byteLength(JSON.stringify(s)) > R.maxRecipeBytes) add("bytes", `The sprite is too detailed to send (over ${R.maxRecipeBytes} bytes); simplify it.`);
    if (errors.length === 0) return { ok: true, opaque, feet: maxY };
    return { ok: false, errors };
  }
  if (byteLength(JSON.stringify(s)) > R.maxRecipeBytes) add("bytes", `The sprite is too detailed to send (over ${R.maxRecipeBytes} bytes); simplify it.`);
  return { ok: false, errors };
}

/**
 * When the feet are outside the tolerance of y = 60, shifts the image vertically so they land on it,
 * provided the margins still hold. Otherwise (or for a blank sprite) returns the input unchanged.
 */
export function shiftToFeet(s: PixelSprite): PixelSprite {
  const px = decodePixels(s.pixels);
  if (!px) return s;
  const feet = feetRow(s);
  if (feet < 0 || Math.abs(feet - PIXEL_RULES.feetY) <= PIXEL_RULES.feetTolerance) return s;
  const dy = PIXEL_RULES.feetY - feet;
  let minY = PIXEL_HEIGHT;
  for (let i = 0; i < px.length; i++) if (px[i]) minY = Math.min(minY, (i / PIXEL_WIDTH) | 0);
  if (minY + dy < PIXEL_RULES.margin) return s;
  const out = new Uint8Array(PIXEL_COUNT);
  for (let i = 0; i < px.length; i++) if (px[i]) out[i + dy * PIXEL_WIDTH] = px[i]!;
  return { ...s, pixels: encodePixels(out) };
}
