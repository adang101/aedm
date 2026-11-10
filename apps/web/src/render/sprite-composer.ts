/**
 * Draws a `SpriteSpec` (body plan + parts + palette) on the 48 x 64 sprite canvas, facing right with the
 * feet on y = 60 and the neck anchor at (24, 32). The result is pre-rendered once per (spec, facing, frame,
 * pose) to an offscreen canvas and cached, so drawing an entity is one drawImage.
 *
 * Pipeline: layers (behind, body, head, held, front) -> pose shaping -> size scale (nearest) -> 1px outline
 * in #1b1626 by an offset-mask pass -> optional mirror for facing left.
 */
import { PART_CATALOG, type Part, type SpritePose, type SpriteSpec } from "@aedm/schemas";
import { OUTLINE, hashString } from "./palette";
import { Pen, ctxOf, makeCanvas } from "./px";
import { FEET_Y, SIZE_SCALE, anchorsFor } from "./sprite-anchors";
import { BODY_DRAWERS } from "./sprite-bodies";
import { palOf } from "./sprite-kit";
import { PART_DRAWERS, type PartLayer } from "./sprite-parts";

/** Working canvas: the 48 x 64 sprite plus a margin so wings, hats and flames are not clipped. */
export const MARGIN = 16;
export const WORK_W = 48 + MARGIN * 2;
export const WORK_H = 64 + MARGIN * 2;

export type Facing = "left" | "right";

export interface Composed {
  canvas: HTMLCanvasElement;
  /** Where the middle of the feet is on `canvas`. */
  footX: number;
  footY: number;
  scale: number;
}

/** Hook for generated art (M3): return a ready image for `image_asset_id`, or null to draw procedurally. */
export function getSpriteImage(_id: string): CanvasImageSource | null {
  return null;
}

/** Everything that changes how the spec is drawn (not `traits` or `image_asset_id`). */
export function specKey(spec: SpriteSpec): string {
  const p = spec.palette;
  const parts = spec.parts.map((x) => `${x.part}.${x.color ?? ""}.${x.side ?? ""}`).join(",");
  return `${spec.body}|${spec.size}|${spec.pose ?? ""}|${p.primary}${p.secondary}${p.accent}${p.detail}|${parts}|${spec.glyph ?? ""}`.toLowerCase();
}

/** Short stable hash of a spec, for debugging and cache names. */
export function specHash(spec: SpriteSpec): string {
  return hashString(specKey(spec)).toString(16).padStart(8, "0");
}

export function effectivePose(spec: SpriteSpec, override?: SpritePose): SpritePose {
  return override ?? spec.pose ?? (spec.body === "spirit" ? "floating" : "idle");
}

/** Relative size of the ground shadow under a pose. */
export const POSE_SHADOW: Record<SpritePose, number> = { idle: 1, aggressive: 1, cowering: 0.85, floating: 0.6 };

const LAYERS: readonly PartLayer[] = ["behind", "body", "head", "held", "front"];

function drawLayers(spec: SpriteSpec, pose: SpritePose, frame: number): HTMLCanvasElement {
  const canvas = makeCanvas(WORK_W, WORK_H);
  const g = ctxOf(canvas);
  g.translate(MARGIN, MARGIN);
  const lift = pose === "floating" ? -6 - (frame ? 2 : 0) : frame ? -1 : 0;
  g.translate(0, lift);
  const p = new Pen(g);
  const a = anchorsFor(spec.body, pose);
  const pal = palOf(spec.palette);
  const drawPart = (layer: PartLayer) => {
    for (const part of spec.parts) {
      const def = PART_DRAWERS[part.part];
      if (!def || def.layer !== layer) continue;
      def.draw({ p, a, pal, c: pal[part.color ?? def.color], side: part.side ?? "both", frame, pose, body: spec.body });
    }
  };
  for (const layer of LAYERS) {
    drawPart(layer);
    if (layer === "behind") BODY_DRAWERS[spec.body]({ p, a, pal, frame });
    if (layer === "body" && spec.body === "object" && spec.glyph) {
      g.font = "bold 13px ui-sans-serif, system-ui, sans-serif";
      g.textAlign = "center"; g.textBaseline = "middle";
      g.lineWidth = 3; g.strokeStyle = pal.secondary.dk; g.strokeText(spec.glyph, 24, 51);
      g.fillStyle = pal.accent.hi; g.fillText(spec.glyph, 24, 51);
    }
  }
  return canvas;
}

function shapePose(src: HTMLCanvasElement, pose: SpritePose): HTMLCanvasElement {
  if (pose !== "aggressive" && pose !== "cowering") return src;
  const out = makeCanvas(WORK_W, WORK_H);
  const g = ctxOf(out);
  const footY = MARGIN + FEET_Y;
  if (pose === "aggressive") {
    // lean forward: higher rows shift to the right
    for (let y = 0; y < WORK_H; y++) {
      const shift = Math.round(Math.max(0, footY - y) * 0.085);
      g.drawImage(src, 0, y, WORK_W, 1, shift, y, WORK_W, 1);
    }
  } else {
    // cower: smaller and lower, squashed a little more vertically
    const sx = 0.92, sy = 0.8, fx = MARGIN + 24;
    g.drawImage(src, 0, 0, WORK_W, WORK_H, fx - fx * sx, footY - footY * sy, WORK_W * sx, WORK_H * sy);
  }
  return out;
}

function outlined(src: HTMLCanvasElement): HTMLCanvasElement {
  const sil = makeCanvas(src.width, src.height);
  const sg = ctxOf(sil);
  sg.drawImage(src, 0, 0);
  sg.globalCompositeOperation = "source-in";
  sg.fillStyle = OUTLINE;
  sg.fillRect(0, 0, sil.width, sil.height);
  const out = makeCanvas(src.width, src.height);
  const g = ctxOf(out);
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) g.drawImage(sil, dx, dy);
  g.drawImage(src, 0, 0);
  return out;
}

const cache = new Map<string, Composed>();

export function clearSpriteCache(): void {
  cache.clear();
}

export function spriteCacheSize(): number {
  return cache.size;
}

export function composeKey(spec: SpriteSpec, facing: Facing, frame: number, pose: SpritePose): string {
  return `${specKey(spec)}#${facing}#${frame % 2}#${pose}`;
}

/** The composed sprite for a spec, drawn once and cached. Pass `pose` to override the spec's own pose. */
export function composeSprite(spec: SpriteSpec, facing: Facing = "right", frame = 0, poseOverride?: SpritePose): Composed {
  const pose = effectivePose(spec, poseOverride);
  const key = composeKey(spec, facing, frame, pose);
  const hit = cache.get(key);
  if (hit) return hit;

  const scale = SIZE_SCALE[spec.size];
  const work = shapePose(drawLayers(spec, pose, frame % 2), pose);
  const w = Math.ceil(WORK_W * scale), h = Math.ceil(WORK_H * scale);
  let scaled = work;
  if (scale !== 1) {
    scaled = makeCanvas(w, h);
    ctxOf(scaled).drawImage(work, 0, 0, WORK_W, WORK_H, 0, 0, WORK_W * scale, WORK_H * scale);
  }
  let canvas = outlined(scaled);
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
  const out: Composed = { canvas, footX, footY, scale };
  cache.set(key, out);
  return out;
}

/** Part names the composer can draw; the test compares this with the schema catalog. */
export const DRAWABLE_PARTS: readonly Part[] = (Object.keys(PART_DRAWERS) as Part[]).filter((k) => PART_CATALOG.includes(k));
