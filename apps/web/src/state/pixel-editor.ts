/**
 * Pure state and algorithms of the pixel editor (no DOM): the 48 x 64 working image, tools, undo and the
 * conversion to and from the `pixel` recipe. The image holds master palette ids: 0 is transparent and
 * id n is `PALETTE_HEX[n - 1]` (33 colors). The recipe palette is built from the colors in use on export.
 */
import {
  MAX_PIXEL_COLORS, PALETTE_HEX, PIXEL_COUNT, PIXEL_HEIGHT, PIXEL_WIDTH, decodePixels, encodePixels, snapToPalette,
  type PixelSprite, type SpriteSize, type SpriteSpec,
} from "@aedm/schemas";
import { shiftToFeet, validatePixelSprite, type PixelIssue, PIXEL_RULES } from "@aedm/engine";

export const W = PIXEL_WIDTH;
export const H = PIXEL_HEIGHT;
export const MAX_UNDO = 50;
export const MIN_ZOOM = 4;
export const MAX_ZOOM = 12;
export const ERASE = 0;

export type Tool = "pencil" | "eraser" | "fill" | "eyedropper" | "line" | "rect";
export const TOOLS: readonly Tool[] = ["pencil", "eraser", "fill", "eyedropper", "line", "rect"];
export type Cell = readonly [x: number, y: number];

export const blank = (): Uint8Array => new Uint8Array(PIXEL_COUNT);
export const inBounds = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < W && y < H;

export function colorId(hex: string): number {
  return PALETTE_HEX.indexOf(hex.toLowerCase()) + 1;
}
export function idColor(id: number): string | undefined {
  return id > 0 ? PALETTE_HEX[id - 1] : undefined;
}

// ---------- history ----------

export interface EditorState {
  px: Uint8Array;
  past: Uint8Array[];
  future: Uint8Array[];
}

export function createEditor(px: Uint8Array = blank()): EditorState {
  return { px: px.slice(), past: [], future: [] };
}

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** Records `next` as one undo step (at most MAX_UNDO kept). An unchanged image adds nothing. */
export function commit(s: EditorState, next: Uint8Array): EditorState {
  if (same(s.px, next)) return s;
  const past = [...s.past, s.px];
  if (past.length > MAX_UNDO) past.shift();
  return { px: next, past, future: [] };
}

export function undo(s: EditorState): EditorState {
  const prev = s.past[s.past.length - 1];
  if (!prev) return s;
  return { px: prev, past: s.past.slice(0, -1), future: [...s.future, s.px] };
}

export function redo(s: EditorState): EditorState {
  const next = s.future[s.future.length - 1];
  if (!next) return s;
  return { px: next, past: [...s.past, s.px], future: s.future.slice(0, -1) };
}

// ---------- tools ----------

/** Cells of a line, endpoints included (Bresenham). */
export function lineCells(x0: number, y0: number, x1: number, y1: number): Cell[] {
  const out: Cell[] = [];
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy, x = x0, y = y0;
  for (;;) {
    out.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
  return out;
}

/** Cells of the rectangle between two corners: filled, or just its border. */
export function rectCells(x0: number, y0: number, x1: number, y1: number, filled: boolean): Cell[] {
  const ax = Math.min(x0, x1), bx = Math.max(x0, x1), ay = Math.min(y0, y1), by = Math.max(y0, y1);
  const out: Cell[] = [];
  for (let y = ay; y <= by; y++) {
    for (let x = ax; x <= bx; x++) if (filled || x === ax || x === bx || y === ay || y === by) out.push([x, y]);
  }
  return out;
}

/** Adds the horizontal mirror image (x to 47 - x) of every cell. */
export function withMirror(cells: readonly Cell[], on: boolean): Cell[] {
  if (!on) return [...cells];
  return [...cells, ...cells.map(([x, y]): Cell => [W - 1 - x, y])];
}

/** A copy of `px` with the in-bounds cells set to `id`. */
export function paintCells(px: Uint8Array, cells: readonly Cell[], id: number): Uint8Array {
  const out = px.slice();
  for (const [x, y] of cells) if (inBounds(x, y)) out[y * W + x] = id;
  return out;
}

/** 4-connected flood fill of the region under (x, y). Returns the same array when nothing changes. */
export function floodFill(px: Uint8Array, x: number, y: number, id: number): Uint8Array {
  if (!inBounds(x, y)) return px;
  const target = px[y * W + x]!;
  if (target === id) return px;
  const out = px.slice();
  const stack: number[] = [y * W + x];
  while (stack.length) {
    const i = stack.pop()!;
    if (out[i] !== target) continue;
    out[i] = id;
    const cx = i % W, cy = (i / W) | 0;
    if (cx > 0) stack.push(i - 1);
    if (cx < W - 1) stack.push(i + 1);
    if (cy > 0) stack.push(i - W);
    if (cy < H - 1) stack.push(i + W);
  }
  return out;
}

/** Fill with mirror: also fills the region under the mirrored point. */
export function fillMirrored(px: Uint8Array, x: number, y: number, id: number, mirror: boolean): Uint8Array {
  const a = floodFill(px, x, y, id);
  return mirror ? floodFill(a, W - 1 - x, y, id) : a;
}

export function pick(px: Uint8Array, x: number, y: number): number {
  return inBounds(x, y) ? px[y * W + x]! : 0;
}

export const clampZoom = (z: number): number => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(z)));

/** Keyboard shortcuts: B pencil, E eraser, G fill, I eyedropper, plus L line and R rectangle. */
export function toolForKey(key: string): Tool | undefined {
  switch (key.toLowerCase()) {
    case "b": return "pencil";
    case "e": return "eraser";
    case "g": return "fill";
    case "i": return "eyedropper";
    case "l": return "line";
    case "r": return "rect";
    default: return undefined;
  }
}

// ---------- recipe conversion ----------

/** Distinct colors used. */
export function colorCount(px: Uint8Array): number {
  const seen = new Set<number>();
  for (const v of px) if (v) seen.add(v);
  return seen.size;
}

export function opaqueCount(px: Uint8Array): number {
  let n = 0;
  for (const v of px) if (v) n++;
  return n;
}

/**
 * RGBA (48 x 64) to master ids. Alpha under 128 is transparent; every other color snaps to the nearest
 * master palette color.
 */
export function fromRgba(data: ArrayLike<number>): Uint8Array {
  const out = blank();
  const memo = new Map<number, number>();
  for (let i = 0; i < PIXEL_COUNT; i++) {
    if ((data[i * 4 + 3] ?? 0) < 128) continue;
    const r = data[i * 4]!, g = data[i * 4 + 1]!, b = data[i * 4 + 2]!;
    const key = (r << 16) | (g << 8) | b;
    let id = memo.get(key);
    if (id === undefined) {
      const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
      id = colorId(snapToPalette(hex));
      memo.set(key, id);
    }
    out[i] = id;
  }
  return out;
}

/** Master ids of a recipe's pixels, or undefined when its data does not decode. */
export function fromRecipe(s: PixelSprite): Uint8Array | undefined {
  const idx = decodePixels(s.pixels);
  if (!idx) return undefined;
  const map = s.palette.map((c) => colorId(snapToPalette(c)));
  const out = blank();
  for (let i = 0; i < out.length; i++) out[i] = idx[i] ? (map[idx[i]! - 1] ?? 0) : 0;
  return out;
}

export interface RecipeOptions { size: SpriteSize; base?: SpriteSpec | undefined; traits?: string | undefined }

/** Builds the recipe from the image (palette in master order). Throws above MAX_PIXEL_COLORS colors. */
export function toRecipe(px: Uint8Array, o: RecipeOptions): PixelSprite {
  const used = [...new Set(px)].filter((v) => v > 0).sort((a, b) => a - b);
  if (used.length > MAX_PIXEL_COLORS) throw new Error("too many colors");
  const remap = new Map(used.map((id, i) => [id, i + 1]));
  const idx = new Uint8Array(PIXEL_COUNT);
  for (let i = 0; i < idx.length; i++) idx[i] = px[i] ? remap.get(px[i]!)! : 0;
  const sprite: PixelSprite = {
    kind: "pixel", v: 1, width: 48, height: 64,
    palette: used.map((id) => PALETTE_HEX[id - 1]!),
    pixels: encodePixels(idx),
    size: o.size,
    traits: (o.traits ?? o.base?.traits ?? "").slice(0, 160),
  };
  if (o.base) sprite.base = o.base;
  return sprite;
}

export interface Check {
  /** The recipe to save, with the feet shifted when needed; absent when the image cannot be encoded. */
  sprite?: PixelSprite;
  ok: boolean;
  issues: PixelIssue[];
  /** Rows the image was moved down (negative: up) so the feet land on the guide. */
  shifted: number;
  colors: number;
  opaque: number;
}

/** Live validation: encode, auto-shift the feet when off, run the engine rules. */
export function checkImage(px: Uint8Array, o: RecipeOptions): Check {
  const colors = colorCount(px), opaque = opaqueCount(px);
  if (colors > PIXEL_RULES.maxColors) {
    return { ok: false, colors, opaque, shifted: 0, issues: [{ code: "colors", message: `Use at most ${PIXEL_RULES.maxColors} colors (this has ${colors}).` }] };
  }
  const raw = toRecipe(px, o);
  const sprite = shiftToFeet(raw);
  let shifted = 0;
  if (sprite !== raw) {
    const a = lowestRow(fromRecipe(raw)!), b = lowestRow(fromRecipe(sprite)!);
    shifted = b - a;
  }
  const r = validatePixelSprite(sprite);
  return { sprite, ok: r.ok, issues: r.ok ? [] : r.errors, shifted, colors, opaque };
}

function lowestRow(px: Uint8Array): number {
  for (let y = H - 1; y >= 0; y--) for (let x = 0; x < W; x++) if (px[y * W + x]) return y;
  return -1;
}
