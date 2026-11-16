/**
 * Static terrain, pre-rendered into cached chunk canvases (8 x 8 tiles each, with a 1px border of the
 * neighbouring pixels so that blits at fractional zoom never show a seam). A chunk holds the blended ground,
 * water bands and shore, cast shadows, scattered details, walls and doorways. Chunks in the view are built the
 * first time they are needed; chunks around the view are built ahead of the camera in small time slices, so
 * scrolling never builds on demand. Every frame is then a handful of drawImage calls; only things that change
 * are drawn per frame: water glints, hazard motifs and their glow.
 *
 * Every pixel is a function of (map id, world position, material), never of chunk or time of drawing, so chunks
 * agree with each other and with every other client.
 */
import { hazardGlow } from "./props";
import { OUTLINE, mixHex, parseHex, shade } from "./palette";
import { Pen, ctxOf, makeCanvas, type Ctx } from "./px";
import { TILE } from "./camera";
import { REACH_SCALE, REACH_STEP, T, TerrainGrid, type MatInfo, type Owner } from "./terrain-grid";
import { LatticeField, hash01, hash2, latticeNoise, rectDist, scatterKinds, type ScatterKind } from "./terrain-math";
import type { MapStyle } from "./tiles";

export const CHUNK_TILES = 8;
const S = CHUNK_TILES * T;
const PAD = 1;
const PS = S + 2 * PAD;
const MAX_CHUNKS = 56;

const pack = (r: number, g: number, b: number): number => (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
const packHex = (hex: string): number => { const [r, g, b] = parseHex(hex); return pack(r, g, b); };
const unpackHex = (c: number): string => {
  const h = (c & 0xffffff).toString(16).padStart(6, "0"); // bbggrr
  return `#${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`;
};

/** Memoised color transforms on packed pixels, so per-pixel tone work is a map lookup. */
class Lut {
  private m = new Map<number, number>();
  constructor(private f: (hex: string) => string) {}
  get(c: number): number {
    let v = this.m.get(c);
    if (v === undefined) { v = packHex(this.f(unpackHex(c))); this.m.set(c, v); }
    return v;
  }
}
const OUTLINE_PX = packHex(OUTLINE);
const LIGHTEN = new Lut((h) => mixHex(h, shade(h, 1), 0.22));
const DARKEN = new Lut((h) => mixHex(h, shade(h, -1), 0.28));
const SHADOW = new Lut((h) => mixHex(shade(h, -1), OUTLINE, 0.12));
const SHADOW_CORE = new Lut((h) => mixHex(shade(h, -1), OUTLINE, 0.34));
const RIM = new Lut((h) => mixHex(h, shade(h, -1), 0.65));
const SHALLOW = new Lut((h) => mixHex(h, shade(h, 1), 0.55));
const DEEP = new Lut((h) => mixHex(h, shade(h, -1), 0.5));
const FOAM = new Lut((h) => mixHex(shade(h, 2), "#ffffff", 0.45));

interface Glint { x: number; y: number; len: number; phase: number; spark: boolean }

interface Chunk {
  canvas: HTMLCanvasElement;
  glints: Glint[];
  hasWater: boolean;
  used: number;
}

interface MatTex {
  tiles: Uint32Array[];
  byGid: Map<number, Uint32Array>;
  base: number;
  hi: number;
  sh: number;
  foam: number;
  kinds: ScatterKind[];
}

/** A chunk whose pixel pass is under way. */
interface Build {
  cx: number; cy: number; ox: number; oy: number;
  canvas: HTMLCanvasElement;
  ctx: Ctx;
  img: ImageData;
  buf: Uint32Array;
  depth: Uint8Array;
  row: number;
  hasWater: boolean;
  reach: LatticeField | null;
  tone: LatticeField;
  region: LatticeField;
  jitter: LatticeField | null;
  ms: number;
}

export interface Rect { x0: number; y0: number; x1: number; y1: number }

interface ShoreRect { rx: number; ry: number; lo: number; hi: number }

export class TerrainCache {
  private chunks = new Map<number, Chunk>();
  private partial = new Map<number, Build>();
  private tex: (MatTex | undefined)[] = [];
  private shores = new Map<number, ShoreRect[]>();
  private nearWall: Int8Array;
  private scratch: Ctx | null = null;
  private tick = 0;
  readonly cw: number;
  readonly ch: number;
  /** Chunks built so far and the milliseconds spent building them (for the gallery and measurements). */
  built = 0;
  buildMs = 0;
  private r: Owner = { mat: -1, gid: 0, rim: false, bled: false };

  constructor(readonly grid: TerrainGrid, private style: MapStyle) {
    this.cw = Math.ceil(grid.w / CHUNK_TILES);
    this.ch = Math.ceil(grid.h / CHUNK_TILES);
    this.nearWall = new Int8Array(grid.w * grid.h).fill(-1);
  }

  // ---------- textures ----------

  private readTile(def: MatInfo["def"]): Uint32Array {
    const c = this.style.patternCanvas(def);
    return new Uint32Array(ctxOf(c).getImageData(0, 0, T, T).data.buffer.slice(0));
  }

  private texOf(mi: number): MatTex {
    let t = this.tex[mi];
    if (t) return t;
    const m = this.grid.mats[mi]!;
    const tiles: Uint32Array[] = [];
    if (m.organic && !m.liquid) for (let k = 0; k < 4; k++) tiles.push(this.readTile({ ...m.def, variant: k }));
    else if (!m.liquid) tiles.push(this.readTile(m.def));
    const base = packHex(m.def.color);
    t = {
      tiles, byGid: new Map(), base,
      hi: packHex(shade(m.def.color, 1)), sh: packHex(shade(m.def.color, -1)),
      foam: FOAM.get(base), kinds: scatterKinds(m.def),
    };
    this.tex[mi] = t;
    return t;
  }

  private structured(t: MatTex, m: MatInfo, gid: number): Uint32Array {
    let a = t.byGid.get(gid);
    if (!a) {
      a = gid === m.def.gid ? t.tiles[0]! : this.readTile(this.style.def(gid) ?? m.def);
      t.byGid.set(gid, a);
    }
    return a;
  }

  // ---------- water ----------

  private shoreOf(tx: number, ty: number): ShoreRect[] {
    const i = ty * this.grid.w + tx;
    let s = this.shores.get(i);
    if (s) return s;
    s = [];
    const g = this.grid;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = tx + dx, ny = ty + dy;
        if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h) continue;
        const m = g.cellMat[ny * g.w + nx]!;
        if (m >= 0 && g.mats[m]!.liquid) continue;
        const r = m >= 0 ? g.mats[m]!.reach : { lo: 0, hi: 0 };
        s.push({ rx: nx * T, ry: ny * T, lo: r.lo, hi: r.hi });
      }
    }
    this.shores.set(i, s);
    return s;
  }

  /** Distance in pixels from a water pixel to the shore line (99 when no shore is near). */
  private shoreDist(tx: number, ty: number, wx: number, wy: number, n: number): number {
    const sh = this.shoreOf(tx, ty);
    let d = 99;
    for (let k = 0; k < sh.length; k++) {
      const s = sh[k]!;
      const v = rectDist(wx, wy, s.rx, s.ry, T, T) - (s.lo + (s.hi - s.lo) * n);
      if (v < d) d = v;
    }
    return d;
  }

  private waterColor(t: MatTex, wx: number, wy: number, d: number, jit: number): number {
    const seed = this.grid.seed;
    const dd = d + (jit - 0.5) * 6;
    if (dd < 1.4) return hash01(seed + 17, wx, wy) > 0.32 ? t.foam : t.hi;
    const cx = Math.floor(wx / 22), par = cx & 1;
    const cy = Math.floor((wy + par * 5) / 10);
    const h = hash2(seed + 41, cx, cy);
    const shallow = dd < 7, deep = dd > 24;
    if ((h & 3) < 2) {
      // static ripple dashes on a staggered lattice
      const row = cy * 10 + ((h >>> 3) & 7) - par * 5;
      const x0 = cx * 22 + ((h >>> 8) & 7), len = 4 + ((h >>> 12) & 7);
      if (wy === row + Math.round(Math.sin(wx / 4 + (h & 15))) && wx >= x0 && wx < x0 + len) return shallow ? t.hi : t.sh;
    }
    return shallow ? SHALLOW.get(t.base) : deep ? DEEP.get(t.base) : t.base;
  }

  // ---------- chunk building ----------

  private wallPx(wx: number, wy: number): boolean {
    return this.grid.isWall(Math.floor(wx / T), Math.floor(wy / T));
  }

  private near(tx: number, ty: number): boolean {
    const i = ty * this.grid.w + tx;
    let v = this.nearWall[i]!;
    if (v < 0) { v = this.grid.nearWall(tx, ty) ? 1 : 0; this.nearWall[i] = v; }
    return v === 1;
  }

  private start(cx: number, cy: number): Build {
    const ox = cx * S - PAD, oy = cy * S - PAD;
    const canvas = makeCanvas(PS, PS);
    const ctx = ctxOf(canvas);
    const img = ctx.createImageData(PS, PS);
    const seed = this.grid.seed;
    return {
      cx, cy, ox, oy, canvas, ctx, img, buf: new Uint32Array(img.data.buffer), depth: new Uint8Array(PS * PS), row: 0, hasWater: false,
      reach: null, tone: new LatticeField(seed + 3, 52, 6, ox, oy, PS, PS), region: new LatticeField(seed + 29, 34, 6, ox, oy, PS, PS),
      jitter: null, ms: 0,
    };
  }

  /** Texture of a land material at a world pixel with the low-frequency tone variation that crosses tile borders. */
  private landColor(b: Build, t: MatTex, m: MatInfo, gid: number, wx: number, wy: number): number {
    let c: number;
    if (m.organic) {
      const n = b.region.at(wx, wy);
      const k = Math.max(0, Math.min(3, Math.floor(n * 4.4 - 0.2)));
      c = t.tiles[k % t.tiles.length]![(((wy + k * 17) % T) * T) + ((wx + k * 29) % T)]!;
    } else c = this.structured(t, m, gid)[(wy % T) * T + (wx % T)]!;
    const tn = b.tone.at(wx, wy);
    if (tn > 0.62) c = LIGHTEN.get(c); else if (tn < 0.38) c = DARKEN.get(c);
    return c;
  }

  /** Natural walls: the neighbouring ground reaches into the wall cell with an organic edge and a dark contact line. */
  private roundWallCell(b: Build, tx: number, ty: number, xa: number, xb: number, py: number, wy: number, reach: LatticeField): void {
    const g = this.grid, r = this.r;
    const wx0 = Math.max(xa, tx * T), wx1 = Math.min(xb, (tx + 1) * T);
    if (g.wallClaimers(tx, ty).length === 0) return;
    for (let wx = wx0; wx < wx1; wx++) {
      g.resolveWall(tx, ty, wx, wy, r, reach.at(wx, wy));
      if (r.mat < 0) continue;
      const m = g.mats[r.mat]!;
      b.buf[py * PS + (wx - b.ox)] = r.rim ? OUTLINE_PX : this.landColor(b, this.texOf(r.mat), m, r.gid, wx, wy);
    }
  }

  /** Runs the pixel pass for up to `budgetMs` (or to the end when it is Infinity). Returns true when the pass is done. */
  private advance(b: Build, budgetMs: number): boolean {
    const t0 = performance.now();
    const g = this.grid, seed = g.seed;
    const maxX = g.w * T, maxY = g.h * T;
    const r = this.r;
    const xa = Math.max(0, b.ox), xb = Math.min(maxX, b.ox + PS);
    if (b.reach === null) b.reach = new LatticeField(seed + 7, REACH_SCALE, REACH_STEP, b.ox, b.oy, PS, PS);
    const reach = b.reach;
    while (b.row < PS) {
      const py = b.row++;
      const wy = b.oy + py;
      if (wy >= 0 && wy < maxY) {
        const ty = Math.floor(wy / T);
        for (let tx = Math.floor(xa / T); tx <= Math.floor((xb - 1) / T); tx++) {
          const mi0 = g.cellMat[ty * g.w + tx]!;
          if (mi0 < 0) {
            if (g.roundWalls && g.wall[ty * g.w + tx]) this.roundWallCell(b, tx, ty, xa, xb, py, wy, reach);
            continue;
          }
          const hasCl = g.claimers(tx, ty).length > 0;
          const shadowy = this.near(tx, ty);
          const wx0 = Math.max(xa, tx * T), wx1 = Math.min(xb, (tx + 1) * T);
          for (let wx = wx0; wx < wx1; wx++) {
            const px = wx - b.ox;
            if (hasCl) g.resolveIn(tx, ty, wx, wy, r, reach.at(wx, wy));
            else { r.mat = mi0; r.gid = g.cellGid[ty * g.w + tx]!; r.rim = false; }
            const m = g.mats[r.mat]!;
            const t = this.texOf(r.mat);
            let c: number;
            if (m.liquid) {
              if (!b.jitter) b.jitter = new LatticeField(seed + 13, 7, 3, b.ox, b.oy, PS, PS);
              const d = this.shoreDist(tx, ty, wx, wy, reach.at(wx, wy));
              c = this.waterColor(t, wx, wy, d, b.jitter.at(wx, wy));
              b.depth[py * PS + px] = Math.max(1, Math.min(255, Math.round(d) + 1));
              b.hasWater = true;
            } else {
              c = this.landColor(b, t, m, r.gid, wx, wy);
              if (r.rim) c = RIM.get(c);
              else if (shadowy) {
                if (this.wallPx(wx - 2, wy - 3) || this.wallPx(wx - 1, wy - 4)) c = SHADOW_CORE.get(c);
                else if (this.wallPx(wx - 4, wy - 7)) c = SHADOW.get(c);
              }
            }
            b.buf[py * PS + px] = c;
          }
        }
      }
      if ((py & 7) === 7 && performance.now() - t0 > budgetMs) break;
    }
    b.ms += performance.now() - t0;
    return b.row >= PS;
  }

  private finish(b: Build): Chunk {
    const t0 = performance.now();
    // walls first, then the ground over them (it is transparent on wall cells except where it reaches into rock), then doorways and details
    this.structures(b.ctx, b, "walls");
    const scratch = this.scratch ?? (this.scratch = ctxOf(makeCanvas(PS, PS)));
    scratch.putImageData(b.img, 0, 0);
    b.ctx.drawImage(scratch.canvas, 0, 0);
    this.structures(b.ctx, b, "doors");
    this.stamps(new Pen(b.ctx), b);
    const glints = b.hasWater ? this.makeGlints(b) : [];
    this.built++;
    this.buildMs += b.ms + (performance.now() - t0);
    return { canvas: b.canvas, glints, hasWater: b.hasWater, used: this.tick };
  }

  /** Scattered details (pebbles, flowers, cracks, sparkles) at hashed pixel positions, clipped to the owning material. */
  private stamps(pen: Pen, b: Build): void {
    const g = this.grid, seed = g.seed + 55;
    const { ox, oy } = b;
    const tx0 = b.cx * CHUNK_TILES - 1, ty0 = b.cy * CHUNK_TILES - 1;
    const r: Owner = { mat: -1, gid: 0, rim: false, bled: false };
    const own = (wx: number, wy: number, mat: number): boolean => { g.resolve(wx, wy, r); return r.mat === mat && !r.rim; };
    for (let ty = Math.max(0, ty0); ty <= Math.min(g.h - 1, ty0 + CHUNK_TILES + 1); ty++) {
      for (let tx = Math.max(0, tx0); tx <= Math.min(g.w - 1, tx0 + CHUNK_TILES + 1); tx++) {
        const mi = g.cellMat[ty * g.w + tx]!;
        if (mi < 0) continue;
        const t = this.texOf(mi);
        if (t.kinds.length === 0) continue;
        for (let k = 0; k < 2; k++) {
          const h = hash2(seed + k * 7, tx, ty);
          if ((h & 0xff) / 256 > 0.42) continue;
          const kind = t.kinds[(h >>> 8) % t.kinds.length]!;
          const wx = tx * T + 4 + ((h >>> 12) % 38), wy = ty * T + 4 + ((h >>> 18) % 38);
          const lx = wx - ox, ly = wy - oy;
          if (lx < -12 || ly < -12 || lx > PS + 12 || ly > PS + 12) continue;
          const m = g.mats[mi]!;
          const hi = unpackHex(t.hi), sh = unpackHex(t.sh);
          if (kind === "pebble") {
            if (!own(wx, wy, mi) || !own(wx + 2, wy + 1, mi)) continue;
            pen.rect(lx, ly, 2, 1, hi); pen.rect(lx + 1, ly + 1, 2, 1, sh); pen.px(lx, ly + 1, sh);
          } else if (kind === "flower") {
            if (!own(wx, wy, mi) || !own(wx + 2, wy + 2, mi)) continue;
            const acc = m.def.accent.toLowerCase() !== m.def.color.toLowerCase() ? m.def.accent : (["#f6e8a0", "#cbb0f0", "#f5a65b"][(h >>> 24) % 3] as string);
            pen.px(lx, ly + 1, sh); pen.rect(lx, ly - 1, 2, 2, acc); pen.px(lx, ly - 1, shade(acc, 1));
          } else if (kind === "sparkle") {
            if (!own(wx, wy, mi)) continue;
            pen.px(lx, ly, "#ffffff");
            if ((h >>> 24) & 1) { pen.px(lx - 1, ly, hi); pen.px(lx + 1, ly, hi); pen.px(lx, ly - 1, hi); pen.px(lx, ly + 1, hi); }
          } else {
            // a short zigzag crack
            let x = wx, y = wy, ok = true;
            const pts: [number, number][] = [];
            const len = 5 + ((h >>> 20) % 6);
            for (let s = 0; s < len; s++) {
              if (!own(x, y, mi)) { ok = false; break; }
              pts.push([x, y]);
              const hh = hash2(seed + 3, x * 7 + s, y);
              x += (hh & 1) ? 1 : 0; y += ((hh >>> 1) & 1) ? 1 : 0;
              if ((hh >>> 2) % 5 === 0) x -= 2;
            }
            if (!ok || pts.length < 4) continue;
            for (const [px, py] of pts) pen.px(px - ox, py - oy, sh);
          }
        }
      }
    }
  }

  /** Wall tiles and doorways over the ground. */
  private structures(ctx: Ctx, b: Build, what: "walls" | "doors"): void {
    const g = this.grid, st = this.style;
    const { ox, oy } = b;
    const wallAt = (x: number, y: number) => x < 0 || y < 0 || x >= g.w || y >= g.h || g.wall[y * g.w + x] === 1;
    const tx0 = Math.max(0, Math.floor(ox / T)), ty0 = Math.max(0, Math.floor(oy / T));
    const tx1 = Math.min(g.w - 1, Math.floor((ox + PS - 1) / T)), ty1 = Math.min(g.h - 1, Math.floor((oy + PS - 1) / T));
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const i = ty * g.w + tx;
        if (g.wall[i]) {
          if (what === "walls") st.drawWall(ctx, g.wallGid[i]!, tx * T - ox, ty * T - oy, !wallAt(tx, ty + 1), !wallAt(tx, ty - 1), !wallAt(tx - 1, ty), !wallAt(tx + 1, ty));
        } else if (what === "doors" && g.doorGid[i]) {
          const d = st.doorOverlay(g.doorGid[i]!);
          if (d) ctx.drawImage(d, tx * T - ox, ty * T - oy);
        }
      }
    }
  }

  private makeGlints(b: Build): Glint[] {
    const g = this.grid, out: Glint[] = [];
    const { ox, oy, depth } = b;
    const ok = (lx: number, ly: number, len: number): boolean => {
      if (lx < 6 || ly < 6 || lx + len + 8 > PS - 6 || ly > PS - 6) return false;
      for (let x = 0; x < len + 6; x++) if (depth[ly * PS + lx + x]! < 5) return false;
      return true;
    };
    for (let ty = b.cy * CHUNK_TILES; ty < Math.min(g.h, (b.cy + 1) * CHUNK_TILES); ty++) {
      for (let tx = b.cx * CHUNK_TILES; tx < Math.min(g.w, (b.cx + 1) * CHUNK_TILES); tx++) {
        const mi = g.cellMat[ty * g.w + tx]!;
        if (mi < 0 || !g.mats[mi]!.liquid) continue;
        for (let k = 0; k < 3; k++) {
          const h = hash2(g.seed + 77 + k, tx, ty);
          const lx = tx * T + ((h >>> 4) % 40) - ox, ly = ty * T + 2 + ((h >>> 11) % 44) - oy;
          const len = 3 + ((h >>> 20) % 4);
          if (ok(lx, ly, len)) out.push({ x: lx, y: ly, len, phase: hash01(g.seed + 5, tx * 3 + k, ty), spark: k === 2 });
        }
      }
    }
    return out;
  }

  // ---------- public ----------

  private get(cx: number, cy: number): Chunk {
    const key = cy * this.cw + cx;
    let c = this.chunks.get(key);
    if (!c) {
      let b = this.partial.get(key);
      if (!b) b = this.start(cx, cy);
      this.advance(b, Infinity);
      this.partial.delete(key);
      c = this.finish(b);
      this.chunks.set(key, c);
      if (this.chunks.size > MAX_CHUNKS) this.evict();
    }
    c.used = this.tick;
    return c;
  }

  private evict(): void {
    let oldest = -1, oldestUsed = Infinity;
    for (const [k, c] of this.chunks) if (c.used < oldestUsed) { oldest = k; oldestUsed = c.used; }
    if (oldest >= 0) this.chunks.delete(oldest);
  }

  private chunkRange(r: Rect, margin = 0): { c0: number; r0: number; c1: number; r1: number } {
    return {
      c0: Math.max(0, Math.floor(r.x0 / CHUNK_TILES) - margin), r0: Math.max(0, Math.floor(r.y0 / CHUNK_TILES) - margin),
      c1: Math.min(this.cw - 1, Math.floor(r.x1 / CHUNK_TILES) + margin), r1: Math.min(this.ch - 1, Math.floor(r.y1 / CHUNK_TILES) + margin),
    };
  }

  /** Draws the ground, walls and doorways in the tile rect, then the things that move: water glints and hazards. */
  draw(ctx: Ctx, r: Rect, now: number, buildBudgetMs = Infinity): void {
    this.tick++;
    const k = this.chunkRange(r);
    const t0 = performance.now();
    let builtHere = 0;
    for (let cy = k.r0; cy <= k.r1; cy++) {
      for (let cx = k.c0; cx <= k.c1; cx++) {
        // when a whole view has to be built at once (a map just loaded), spread it over a few frames instead of one long freeze
        if (!this.chunks.has(cy * this.cw + cx)) {
          if (builtHere > 0 && performance.now() - t0 > buildBudgetMs) continue;
          builtHere++;
        }
        const c = this.get(cx, cy);
        const ox = cx * S - PAD, oy = cy * S - PAD;
        ctx.drawImage(c.canvas, ox, oy);
        if (c.hasWater) this.drawGlints(ctx, c, ox, oy, now);
      }
    }
    this.drawHazards(ctx, r, now);
  }

  private drawGlints(ctx: Ctx, c: Chunk, ox: number, oy: number, now: number): void {
    for (const gl of c.glints) {
      const t = (now / 1100 + gl.phase) % 1;
      if (gl.spark) {
        if (t > 0.12) continue;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(ox + gl.x + 2, oy + gl.y, 1, 1);
        if (t > 0.04 && t < 0.09) { ctx.fillRect(ox + gl.x + 1, oy + gl.y, 3, 1); ctx.fillRect(ox + gl.x + 2, oy + gl.y - 1, 1, 3); }
      } else {
        if (t > 0.5) continue;
        ctx.fillStyle = t < 0.1 || t > 0.4 ? "#9fd4f5" : "#d8efff";
        ctx.fillRect(ox + gl.x + Math.floor(t * 10), oy + gl.y, gl.len, 1);
      }
    }
  }

  private drawHazards(ctx: Ctx, r: Rect, now: number): void {
    const g = this.grid;
    if (g.hazards.length === 0) return;
    const pen = new Pen(ctx);
    for (const hz of g.hazards) {
      if (hz.x < r.x0 - 1 || hz.x > r.x1 + 1 || hz.y < r.y0 - 1 || hz.y > r.y1 + 1) continue;
      const def = this.style.def(hz.gid);
      if (!def) continue;
      const px = hz.x * TILE, py = hz.y * TILE;
      const pulse = 0.5 + 0.5 * Math.sin(now / 300 + hz.gid);
      ctx.globalAlpha = 0.08 + 0.1 * pulse;
      pen.ell(px + 24, py + 24, 21, 21, hazardGlow(def));
      ctx.globalAlpha = 1;
      const m = this.style.hazardMotif(hz.gid, Math.floor(now / 380 + hz.gid));
      if (m) ctx.drawImage(m, px, py);
    }
  }

  /** Builds the chunks around the view, at most `budgetMs` of work per call, so scrolling never has to build on demand. */
  prefetch(r: Rect, budgetMs: number): void {
    const k = this.chunkRange(r, 1);
    const t0 = performance.now();
    for (let cy = k.r0; cy <= k.r1; cy++) {
      for (let cx = k.c0; cx <= k.c1; cx++) {
        const key = cy * this.cw + cx;
        if (this.chunks.has(key)) continue;
        const left = budgetMs - (performance.now() - t0);
        if (left <= 0) return;
        let b = this.partial.get(key);
        if (!b) { b = this.start(cx, cy); this.partial.set(key, b); }
        if (this.advance(b, left)) {
          this.partial.delete(key);
          this.chunks.set(key, this.finish(b));
          if (this.chunks.size > MAX_CHUNKS) this.evict();
        }
      }
    }
  }

  /** Builds every chunk (gallery, benchmarks). */
  warmAll(): void {
    for (let cy = 0; cy < this.ch; cy++) for (let cx = 0; cx < this.cw; cx++) this.get(cx, cy);
  }

  /** The canonical reach noise (the chunk builder's precomputed field equals it). */
  static reachAt(grid: TerrainGrid, wx: number, wy: number): number {
    return latticeNoise(grid.seed + 7, REACH_SCALE, REACH_STEP, wx, wy);
  }
}
