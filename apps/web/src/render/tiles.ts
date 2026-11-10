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
  chest: "#9a6a3f", door: "#c99a63", lever: "#8b93b0", sign: "#c99a3a", altar: "#9b72d8",
};

export function drawInteractable(ctx: Ctx, kind: string, state: string, px: number, py: number): void {
  const t = tones(KIND_COLOR[kind] ?? "#c4c9dc");
  const p = new Pen(ctx);
  ctx.save();
  ctx.translate(px, py);
  p.ell(24, 40, 13, 4, "rgba(27,22,38,0.34)");
  p.rrect(10, 14, 28, 25, 3, OUTLINE);
  p.rrect(11, 15, 26, 23, 2, t.base);
  p.rect(11, 15, 26, 3, t.hi);
  p.rect(11, 34, 26, 4, t.sh);
  p.rect(11, 24, 26, 2, t.dk);
  p.rect(21, 22, 6, 7, OUTLINE);
  p.rect(22, 23, 4, 5, state === "locked" ? "#c0392b" : "#f6e8a0");
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
