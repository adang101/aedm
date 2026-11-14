/**
 * Tiles from a map's inline tileset. `MapStyle` is built when a map loads: it indexes the TileDefs by gid
 * and pre-renders each one once to an offscreen canvas (cached per gid), so the per-frame work is a drawImage.
 * Role treatments: walls get a top face plus a darker 16px front face, obstacles and decor are props over the
 * floor, liquids animate a crest overlay, hazards pulse and carry an icon motif, doors get a frame.
 */
import type { MaterialRole, TileDef } from "@aedm/schemas";
import { TILE } from "./camera";
import { OUTLINE, mixHex, shade, tones } from "./palette";
import { PATTERN_DRAWERS } from "./patterns";
import { drawDoor, drawHazardMotif, drawProp, hazardGlow, propFrames, propGivesLight, propKindFor, type PropKind } from "./props";
import { Pen, ctxOf, makeCanvas, type Ctx } from "./px";

type Canvas = HTMLCanvasElement;

/** Hook for generated art (M3): return a ready image for `image_asset_id`, or null to draw procedurally. */
export function getTileImage(_id: string): CanvasImageSource | null {
  return null;
}

/** How the renderer places a tile: full 48 x 48 blit, 3/4 wall, or a prop over the floor. */
export type TileClass = "full" | "wall" | "prop";

export function tileClassOf(role: MaterialRole): TileClass {
  switch (role) {
    case "wall": return "wall";
    case "obstacle": case "decor": return "prop";
    default: return "full";
  }
}

export interface PropArt { kind: PropKind; frames: Canvas[]; light: boolean }

export class MapStyle {
  readonly defs = new Map<number, TileDef>();
  /** gid drawn under props and where the ground layer is empty. */
  readonly underlay: number;
  private full = new Map<number, Canvas[]>();
  private overlays = new Map<number, Canvas>();
  private walls = new Map<string, Canvas>();
  private props = new Map<number, PropArt>();

  constructor(tiles: readonly TileDef[], floorCounts?: ReadonlyMap<number, number>) {
    for (const t of tiles) this.defs.set(t.gid, t);
    this.underlay = this.pickUnderlay(tiles, floorCounts);
  }

  private pickUnderlay(tiles: readonly TileDef[], counts?: ReadonlyMap<number, number>): number {
    let best = -1, bestN = -1;
    for (const t of tiles) {
      if (t.role !== "floor") continue;
      const n = counts?.get(t.gid) ?? 0;
      if (n > bestN) { best = t.gid; bestN = n; }
    }
    if (best < 0) for (const t of tiles) if (t.role === "path" || t.role === "hazard") return t.gid;
    return best;
  }

  def(gid: number): TileDef | undefined {
    return this.defs.get(gid);
  }

  roleOf(gid: number): MaterialRole | undefined {
    return this.defs.get(gid)?.role;
  }

  classOf(gid: number): TileClass | null {
    const d = this.defs.get(gid);
    return d ? tileClassOf(d.role) : null;
  }

  isWall(gid: number): boolean {
    return this.roleOf(gid) === "wall";
  }

  isLiquid(gid: number): boolean {
    return this.roleOf(gid) === "liquid";
  }

  // ---------- pre-rendering ----------

  private drawPattern(def: TileDef, g: Ctx, layer: "base" | "overlay"): void {
    // big areas of floor stay calm: strong line patterns are drawn at half contrast, walls and accents keep theirs
    const calm = (def.role === "floor" || def.role === "path") && (def.pattern === "cobbles" || def.pattern === "bricks" || def.pattern === "tiles" || def.pattern === "planks");
    PATTERN_DRAWERS[def.pattern](new Pen(g), {
      color: def.color, accent: calm ? mixHex(def.color, def.accent, 0.5) : def.accent, variant: def.variant, seed: def.gid * 7919 + def.variant * 104729,
      role: def.role, layer,
    });
  }

  private buildFull(def: TileDef, frame: number): Canvas {
    const c = makeCanvas(TILE, TILE);
    const g = ctxOf(c);
    const img = def.image_asset_id ? getTileImage(def.image_asset_id) : null;
    if (img) { g.drawImage(img, 0, 0, TILE, TILE); return c; }
    const pen = new Pen(g);
    if (def.role === "door") {
      const under = this.defs.get(this.underlay);
      if (under) this.drawPattern(under, g, "base");
      drawDoor(pen, def);
      return c;
    }
    this.drawPattern(def, g, "base");
    if (def.role === "hazard") drawHazardMotif(pen, def, frame);
    return c;
  }

  /** Frames of a full-tile art (2 for hazards, else 1). */
  fullFrames(gid: number): Canvas[] {
    let f = this.full.get(gid);
    if (!f) {
      const def = this.defs.get(gid);
      f = def ? (def.role === "hazard" && !def.image_asset_id ? [this.buildFull(def, 0), this.buildFull(def, 1)] : [this.buildFull(def, 0)]) : [];
      this.full.set(gid, f);
    }
    return f;
  }

  private overlay(gid: number): Canvas | null {
    const def = this.defs.get(gid);
    if (!def) return null;
    let o = this.overlays.get(gid);
    if (!o) {
      o = makeCanvas(TILE, TILE);
      const pen = new Pen(ctxOf(o));
      PATTERN_DRAWERS.waves(pen, { color: def.color, accent: def.accent, variant: def.variant, seed: gid, role: "liquid", layer: "overlay" });
      this.overlays.set(gid, o);
    }
    return o;
  }

  /**
   * A 3/4 wall tile. `open` = a floor tile lies south, so the front face shows (the bottom 16px); `capped` = the
   * tile north of it is open, so this is the top edge of the wall and its top face is lit. Anywhere else the top
   * is solid mass: a flat dark fill with only a faint trace of the pattern, so thick walls read as solid and the
   * rooms they enclose read as outlines.
   */
  private buildWall(def: TileDef, open: boolean, capped: boolean): Canvas {
    const c = makeCanvas(TILE, TILE);
    const g = ctxOf(c);
    const img = def.image_asset_id ? getTileImage(def.image_asset_id) : null;
    if (img) { g.drawImage(img, 0, 0, TILE, TILE); return c; }
    const pen = new Pen(g);
    const solid = mixHex(def.color, OUTLINE, 0.45);
    if (capped) this.drawPattern(def, g, "base");
    else this.drawPattern({ ...def, color: solid, accent: mixHex(solid, def.accent, 0.22) }, g, "base");
    if (!open) return c;
    const t = tones(def.color);
    const front: TileDef = { ...def, color: shade(def.color, -1), accent: def.accent };
    pen.clipRect(0, 32, TILE, 16, () => {
      g.save();
      g.translate(0, 32);
      this.drawPattern(front, g, "base");
      g.restore();
    });
    pen.rect(0, 31, TILE, 1, OUTLINE);
    pen.rect(0, 32, TILE, 1, t.hi);
    pen.rect(0, 33, TILE, 1, def.color);
    pen.rect(0, 47, TILE, 1, OUTLINE);
    pen.rect(0, 46, TILE, 1, t.dk);
    return c;
  }

  wallArt(gid: number, openBelow: boolean, capped = true): Canvas | null {
    const key = `${gid}:${openBelow ? 1 : 0}${capped ? 1 : 0}`;
    let c = this.walls.get(key);
    if (!c) {
      const def = this.defs.get(gid);
      if (!def) return null;
      c = this.buildWall(def, openBelow, capped);
      this.walls.set(key, c);
    }
    return c;
  }

  propArt(gid: number): PropArt | null {
    let p = this.props.get(gid);
    if (!p) {
      const def = this.defs.get(gid);
      if (!def) return null;
      const kind = propKindFor(def);
      const frames: Canvas[] = [];
      for (let f = 0; f < propFrames(kind); f++) {
        const c = makeCanvas(TILE, TILE + 16);
        drawProp(new Pen(ctxOf(c)), def, f);
        frames.push(c);
      }
      p = { kind, frames, light: propGivesLight(kind) };
      this.props.set(gid, p);
    }
    return p;
  }

  // ---------- drawing ----------

  /** A full tile at world pixel (px, py). `time` in ms drives liquid crests and hazard flicker. */
  drawFull(ctx: Ctx, gid: number, px: number, py: number, time: number): void {
    const def = this.defs.get(gid);
    const frames = this.fullFrames(gid);
    if (!def || frames.length === 0) return;
    const frame = frames.length > 1 ? Math.floor(time / 380 + gid) % frames.length : 0;
    ctx.drawImage(frames[frame]!, px, py);
    if (def.role === "liquid") {
      const ov = this.overlay(gid);
      if (ov) {
        const off = Math.floor(time / 170 + gid * 5) % TILE;
        ctx.drawImage(ov, 0, 0, TILE - off, TILE, px + off, py, TILE - off, TILE);
        if (off > 0) ctx.drawImage(ov, TILE - off, 0, off, TILE, px, py, off, TILE);
      }
    } else if (def.role === "hazard") {
      ctx.globalAlpha = 0.1 + 0.1 * (0.5 + 0.5 * Math.sin(time / 300 + gid));
      ctx.fillStyle = hazardGlow(def);
      ctx.fillRect(px, py, TILE, TILE);
      ctx.globalAlpha = 1;
    }
  }

  /** Cheap 1-2px edge treatment where a liquid meets something else. */
  drawLiquidEdges(ctx: Ctx, gid: number, px: number, py: number, n: boolean, s: boolean, w: boolean, e: boolean): void {
    const def = this.defs.get(gid);
    if (!def) return;
    const t = tones(def.color);
    if (n) { ctx.fillStyle = t.dk; ctx.fillRect(px, py, TILE, 1); ctx.fillStyle = t.hi; ctx.fillRect(px, py + 1, TILE, 2); }
    if (s) { ctx.fillStyle = t.dk; ctx.fillRect(px, py + TILE - 2, TILE, 2); }
    if (w) { ctx.fillStyle = t.dk; ctx.fillRect(px, py, 2, TILE); }
    if (e) { ctx.fillStyle = t.dk; ctx.fillRect(px + TILE - 2, py, 2, TILE); }
  }

  /** A wall; `edges` are the sides that face a non-wall tile (n, w, e) for an outline. */
  drawWall(ctx: Ctx, gid: number, px: number, py: number, openBelow: boolean, edgeN: boolean, edgeW: boolean, edgeE: boolean): void {
    const art = this.wallArt(gid, openBelow, edgeN);
    if (!art) return;
    ctx.drawImage(art, px, py);
    const hi = tones(this.defs.get(gid)?.color ?? "#8b93b0").hi;
    if (edgeN) { ctx.fillStyle = OUTLINE; ctx.fillRect(px, py, TILE, 1); ctx.fillStyle = hi; ctx.fillRect(px, py + 1, TILE, 1); }
    if (edgeW) { ctx.fillStyle = OUTLINE; ctx.fillRect(px, py, 1, openBelow ? 48 : 47); }
    if (edgeE) { ctx.fillStyle = OUTLINE; ctx.fillRect(px + TILE - 1, py, 1, openBelow ? 48 : 47); }
  }

  /** A prop whose base sits on the bottom of the tile at (px, py). Returns the art so callers can add lights. */
  drawProp(ctx: Ctx, gid: number, px: number, py: number, time: number): PropArt | null {
    const art = this.propArt(gid);
    if (!art) return null;
    const frame = art.frames.length > 1 ? Math.floor(time / 210 + gid) % art.frames.length : 0;
    ctx.drawImage(art.frames[frame]!, px, py - 16);
    return art;
  }
}

/** Build the style table for a map: the inline tileset plus the most common floor as the underlay. */
export function createMapStyle(tiles: readonly TileDef[], ground: readonly number[]): MapStyle {
  const counts = new Map<number, number>();
  for (const g of ground) if (g) counts.set(g, (counts.get(g) ?? 0) + 1);
  return new MapStyle(tiles, counts);
}

// ---------- interactables and exits (not part of the tileset) ----------

const KIND_COLOR: Record<string, string> = {
  chest: "#9a6a3f", door: "#9a6a3f", lever: "#8b93b0", sign: "#c99a3a", altar: "#9b72d8",
};
const LOCK_RED = "#c0392b";
const BRASS = "#e8c95a";

/** A small padlock at (x, y), 8 x 9. Red when it still holds, brass when it is a spent latch. */
function padlock(p: Pen, x: number, y: number): void {
  p.rect(x + 1, y, 6, 5, OUTLINE);
  p.rect(x + 2, y + 1, 1, 4, BRASS); p.rect(x + 5, y + 1, 1, 4, BRASS);
  p.rect(x, y + 4, 8, 6, OUTLINE);
  p.rect(x + 1, y + 5, 6, 4, LOCK_RED);
  p.rect(x + 1, y + 5, 6, 1, "#e8683a");
  p.rect(x + 3, y + 6, 2, 2, OUTLINE);
}

function drawChest(p: Pen, state: string): void {
  const t = tones(KIND_COLOR.chest!);
  const brass = tones(BRASS);
  p.rrect(9, 18, 30, 21, 3, OUTLINE);
  p.rect(10, 26, 28, 12, t.base);
  p.rect(10, 34, 28, 4, t.sh);
  p.rect(10, 29, 28, 1, t.dk);
  if (state === "open") {
    // lid thrown back, dark inside, a glint of contents
    p.rrect(9, 8, 30, 12, 3, OUTLINE);
    p.rect(11, 10, 26, 8, t.sh);
    p.rect(11, 10, 26, 2, t.base);
    p.rect(11, 20, 26, 6, OUTLINE);
    p.rect(13, 21, 22, 4, "#2b2030");
    p.rect(17, 22, 3, 2, brass.base); p.rect(24, 22, 4, 2, brass.hi);
  } else {
    p.rect(10, 19, 28, 8, t.base);
    p.rect(10, 19, 28, 2, t.hi);
    p.rect(10, 25, 28, 2, t.dk);
  }
  p.rect(10, 18, 3, 20, brass.sh); p.rect(35, 18, 3, 20, brass.sh);
  if (state === "locked") padlock(p, 20, 23);
  else if (state !== "open") { p.rect(21, 24, 6, 5, OUTLINE); p.rect(22, 25, 4, 3, brass.base); }
}

function drawDoorObject(p: Pen, state: string): void {
  const t = tones(KIND_COLOR.door!);
  const frame = tones("#8b93b0");
  p.rect(7, 2, 34, 44, OUTLINE);
  p.rect(8, 2, 32, 4, frame.base); p.rect(8, 2, 32, 1, frame.hi);
  p.rect(8, 2, 5, 44, frame.base); p.rect(35, 2, 5, 44, frame.sh);
  p.rect(13, 6, 22, 40, state === "open" ? "#2b2030" : OUTLINE);
  if (state === "open") {
    // leaf swung against the left jamb, a lit floor strip through the gap
    p.rect(13, 6, 5, 40, t.dk); p.rect(14, 7, 3, 38, t.base);
    p.rect(19, 42, 16, 4, "rgba(246,232,160,0.22)");
    return;
  }
  p.rect(13, 6, 22, 40, t.dk);
  for (let k = 0; k < 4; k++) { p.rect(14 + k * 5, 7, 4, 38, k % 2 ? t.base : t.hi); p.rect(14 + k * 5, 7, 1, 38, t.dk); }
  p.rect(13, 14, 22, 3, "#5c6380"); p.rect(13, 34, 22, 3, "#5c6380");
  if (state === "locked") {
    p.rect(13, 6, 22, 40, "rgba(27,22,38,0.18)");
    padlock(p, 20, 21);
  } else {
    p.rect(30, 25, 3, 4, BRASS);
  }
}

function drawLever(p: Pen, state: string): void {
  const t = tones(KIND_COLOR.lever!);
  p.rrect(11, 31, 26, 9, 2, OUTLINE);
  p.rect(12, 32, 24, 7, t.base); p.rect(12, 32, 24, 2, t.hi); p.rect(12, 37, 24, 2, t.sh);
  p.rect(21, 27, 6, 6, OUTLINE); p.rect(22, 28, 4, 4, t.dk);
  const pulled = state === "open";
  // handle: up when pushed, thrown to the side when pulled
  if (pulled) { p.line(24, 30, 36, 24, OUTLINE, 4); p.line(24, 30, 36, 24, "#c99a63", 2); p.ell(37, 23, 4, 4, OUTLINE); p.ell(37, 23, 3, 3, "#e8683a"); }
  else { p.line(24, 30, 24, 12, OUTLINE, 4); p.line(24, 30, 24, 12, "#c99a63", 2); p.ell(24, 10, 4, 4, OUTLINE); p.ell(24, 10, 3, 3, "#c0392b"); }
}

function drawSign(p: Pen): void {
  const t = tones(KIND_COLOR.sign!);
  const wood = tones("#70472f");
  p.rect(22, 28, 5, 13, OUTLINE); p.rect(23, 28, 3, 12, wood.base);
  p.rrect(9, 11, 30, 19, 2, OUTLINE);
  p.rect(10, 12, 28, 17, t.base); p.rect(10, 12, 28, 2, t.hi); p.rect(10, 27, 28, 2, t.sh);
  for (const y of [16, 20, 24]) p.rect(13, y, y === 24 ? 14 : 22, 2, wood.dk);
}

function drawAltar(p: Pen, state: string): void {
  const t = tones(KIND_COLOR.altar!);
  p.rrect(8, 22, 32, 18, 2, OUTLINE);
  p.rect(9, 23, 30, 16, t.base); p.rect(9, 23, 30, 3, t.hi); p.rect(9, 35, 30, 4, t.sh);
  p.rect(14, 27, 20, 2, t.dk);
  p.rect(20, 14, 8, 9, OUTLINE); p.rect(21, 15, 6, 7, t.hi);
  p.ell(24, 10, 4, 4, state === "open" ? "#f6e8a0" : "#cbb0f0");
}

export function drawInteractable(ctx: Ctx, kind: string, state: string, px: number, py: number): void {
  const p = new Pen(ctx);
  ctx.save();
  ctx.translate(px, py);
  p.ell(24, 41, 14, 4, "rgba(27,22,38,0.34)");
  switch (kind) {
    case "chest": drawChest(p, state); break;
    case "door": drawDoorObject(p, state); break;
    case "lever": drawLever(p, state); break;
    case "sign": drawSign(p); break;
    case "altar": drawAltar(p, state); break;
    default: {
      const t = tones(KIND_COLOR[kind] ?? "#c4c9dc");
      p.rrect(10, 14, 28, 25, 3, OUTLINE);
      p.rrect(11, 15, 26, 23, 2, t.base);
    }
  }
  ctx.restore();
}

/** A pile of dropped items or the remains of a creature: a small flat marker on its tile. */
export function drawContainerMarker(ctx: Ctx, kind: string, px: number, py: number, time: number): void {
  const p = new Pen(ctx);
  ctx.save();
  ctx.translate(px, py);
  p.ell(24, 36, 13, 5, "rgba(27,22,38,0.34)");
  if (kind === "remains") {
    const bone = tones("#c4c9dc");
    p.ell(24, 34, 11, 4, OUTLINE); p.ell(24, 34, 10, 3, "#5c3a2e");
    p.rrect(14, 29, 20, 3, 1, OUTLINE); p.rect(15, 30, 18, 1, bone.base);
    p.ell(30, 33, 3, 3, OUTLINE); p.ell(30, 33, 2, 2, bone.hi);
    p.rect(17, 34, 6, 2, bone.sh);
  } else {
    // a little heap: sack, coin and a small flask
    const sack = tones("#c99a63");
    p.ell(22, 33, 8, 6, OUTLINE); p.blob(22, 32, 7, 5, sack);
    p.rect(21, 25, 3, 3, OUTLINE); p.rect(21, 26, 3, 2, sack.hi);
    p.ell(33, 36, 4, 3, OUTLINE); p.ell(33, 36, 3, 2, BRASS);
    p.rect(13, 31, 4, 6, OUTLINE); p.rect(14, 32, 2, 4, "#4f9fe0");
  }
  // a glint so the marker reads as something to take
  const a = 0.35 + Math.sin(time / 380 + px) * 0.25;
  ctx.globalAlpha = a;
  p.rect(27, 24, 2, 2, "#fff6c8"); p.rect(26, 25, 4, 1, "#fff6c8");
  ctx.globalAlpha = 1;
  ctx.restore();
}

export function drawExit(ctx: Ctx, px: number, py: number, time: number): void {
  const a = 0.55 + Math.sin(time / 400) * 0.25;
  ctx.globalAlpha = a;
  ctx.fillStyle = "#e8c95a";
  ctx.beginPath();
  ctx.moveTo(px + 24, py + 8); ctx.lineTo(px + 40, py + 38); ctx.lineTo(px + 8, py + 38);
  ctx.closePath();
  ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = OUTLINE; ctx.stroke();
  ctx.globalAlpha = 1;
}
