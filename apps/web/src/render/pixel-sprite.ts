import { PIXEL_HEIGHT, PIXEL_WIDTH, decodePixels, spriteSwatch, type ShapeSpriteRecipe, type SpritePose, type SpriteRecipe } from "@aedm/schemas";
import type { PixelSprite } from "@aedm/schemas";
import { ctxOf, makeCanvas } from "./px";
import { SIZE_SCALE } from "./sprite-anchors";
import { FEET_Y } from "./sprite-anchors";
import { MARGIN, WORK_H, WORK_W, composeSprite, type Composed, type Facing } from "./sprite-composer";

/** Draws decoded palette indices onto a fresh 48 x 64 canvas. Index 0 stays transparent. */
export function paintIndices(px: ArrayLike<number>, palette: readonly string[]): HTMLCanvasElement {
  const c = makeCanvas(PIXEL_WIDTH, PIXEL_HEIGHT);
  const g = ctxOf(c);
  const img = g.createImageData(PIXEL_WIDTH, PIXEL_HEIGHT);
  for (let i = 0; i < PIXEL_WIDTH * PIXEL_HEIGHT; i++) {
    const idx = px[i] ?? 0;
    const hex = idx > 0 ? palette[idx - 1] : undefined;
    if (!hex) continue;
    img.data[i * 4] = parseInt(hex.slice(1, 3), 16);
    img.data[i * 4 + 1] = parseInt(hex.slice(3, 5), 16);
    img.data[i * 4 + 2] = parseInt(hex.slice(5, 7), 16);
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

const cache = new Map<string, Composed | null>();
export function clearPixelCache(): void { cache.clear(); }
export function pixelCacheSize(): number { return cache.size; }

/**
 * The composed painted sprite (same layout as `composeSprite`: feet at the work canvas foot anchor, size
 * scale by nearest-neighbor, mirrored for facing left, one pixel of bob on the second frame). Decoded and
 * drawn once per sprite, facing and frame. Returns undefined when the data does not decode.
 */
export function composePixelSprite(s: PixelSprite, facing: Facing = "right", frame = 0): Composed | undefined {
  const key = `${s.size}|${s.palette.join("")}|${s.pixels}#${facing}#${frame % 2}`;
  if (cache.has(key)) return cache.get(key) ?? undefined;
  let out: Composed | null = null;
  try {
    const px = decodePixels(s.pixels);
    if (px) {
      const src = paintIndices(px, s.palette);
      const scale = SIZE_SCALE[s.size];
      const work = makeCanvas(WORK_W, WORK_H);
      ctxOf(work).drawImage(src, MARGIN, MARGIN + (frame % 2 ? -1 : 0));
      let canvas = work;
      if (scale !== 1) {
        canvas = makeCanvas(WORK_W * scale, WORK_H * scale);
        ctxOf(canvas).drawImage(work, 0, 0, WORK_W, WORK_H, 0, 0, WORK_W * scale, WORK_H * scale);
      }
      let footX = (MARGIN + 24) * scale;
      const footY = (MARGIN + FEET_Y) * scale;
      if (facing === "left") {
        const m = makeCanvas(canvas.width, canvas.height);
        const g = ctxOf(m);
        g.translate(canvas.width, 0);
        g.scale(-1, 1);
        g.drawImage(canvas, 0, 0);
        canvas = m;
        footX = canvas.width - footX;
      }
      out = { canvas, footX, footY, scale };
    }
  } catch { out = null; }
  cache.set(key, out);
  return out ?? undefined;
}

/**
 * Composed image for a spec or pixel recipe. A pixel recipe that fails to decode falls back to its `base`
 * spec; undefined means the caller should draw the shape fallback (see `fallbackShape`).
 */
export function composeRecipe(r: SpriteRecipe, facing: Facing = "right", frame = 0, pose?: SpritePose): Composed | undefined {
  if (r.kind === "spec") return composeSprite(r, facing, frame, pose);
  if (r.kind === "pixel") {
    return composePixelSprite(r, facing, frame) ?? (r.base ? composeSprite(r.base, facing, frame, pose) : undefined);
  }
  return undefined;
}

/** A shape recipe standing in for a sprite that cannot be drawn. */
export function fallbackShape(r: SpriteRecipe, name = "?"): ShapeSpriteRecipe {
  if (r.kind === "shape") return r;
  const w = spriteSwatch(r, name);
  return { kind: "shape", shape: "circle", ...w };
}
