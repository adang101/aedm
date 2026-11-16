/**
 * The ground of a map as a grid of materials, plus the per-pixel question the renderer asks of it:
 * "which material owns this world pixel?". Pure (no DOM), so it is unit-tested.
 *
 * Each cell has one terrain material (floor, path, liquid, hazard; or the underlay under props and doors).
 * Where a higher-ranked material sits next to a lower one it reaches into the lower cell by a wobbling number of
 * pixels (value noise at the pixel's world position), so the boundary is an organic pixel edge that is the same
 * on every client and every frame. Walls are opaque and take no part in the blend.
 */
import type { MaterialRole, TileDef } from "@aedm/schemas";
import { hashString } from "./palette";
import { NEIGHBORS8, ORGANIC_PATTERNS, latticeNoise, materialKey, matRank, outranks, rectDist, roleReach } from "./terrain-math";

export const T = 48;
/** Feature size and lattice step (px) of the noise that wobbles material boundaries. */
export const REACH_SCALE = 14;
export const REACH_STEP = 2;

export interface Owner { mat: number; gid: number; rim: boolean; bled: boolean }

export interface MatInfo {
  idx: number;
  key: string;
  role: MaterialRole;
  rank: number;
  tie: number;
  /** A representative tile def (the first gid of the material). */
  def: TileDef;
  organic: boolean;
  liquid: boolean;
  hazard: boolean;
  reach: { lo: number; hi: number };
}

export interface Claimer { mat: number; gid: number; rx: number; ry: number }

export interface TerrainSource {
  mapId: string;
  w: number;
  h: number;
  ground: readonly number[];
  walls: readonly number[];
  decor: readonly number[];
  defs: ReadonlyMap<number, TileDef>;
  /** gid drawn under props and where the ground is empty (-1 for none). */
  underlay: number;
  /** Natural rock walls (caves): the ground reaches into the wall cells with an organic edge instead of stopping at the tile border. */
  roundWalls?: boolean;
}

const FULL_ROLES: ReadonlySet<MaterialRole> = new Set(["floor", "path", "liquid", "hazard", "door"]);

export class TerrainGrid {
  readonly w: number;
  readonly h: number;
  readonly seed: number;
  readonly mats: MatInfo[] = [];
  readonly matOfGid = new Map<number, number>();
  /** Terrain material per cell, -1 where the cell is a wall (or has no ground at all). */
  readonly cellMat: Int16Array;
  /** The gid whose tile art the cell uses (for structured patterns that follow the 48px grid). */
  readonly cellGid: Int32Array;
  /** 1 for opaque wall cells. */
  readonly wall: Uint8Array;
  /** Door tile gid on the cell, or 0. */
  readonly doorGid: Int32Array;
  /** gid of the wall tile on a wall cell, or 0. */
  readonly wallGid: Int32Array;
  readonly hazards: { x: number; y: number; gid: number }[] = [];
  readonly roundWalls: boolean;
  private claimCache: (Claimer[] | undefined)[];
  private wallClaimCache = new Map<number, Claimer[]>();

  constructor(src: TerrainSource) {
    this.w = src.w; this.h = src.h;
    this.roundWalls = src.roundWalls === true;
    this.seed = hashString(src.mapId) >>> 0;
    const n = src.w * src.h;
    this.cellMat = new Int16Array(n).fill(-1);
    this.cellGid = new Int32Array(n);
    this.wall = new Uint8Array(n);
    this.doorGid = new Int32Array(n);
    this.wallGid = new Int32Array(n);
    this.claimCache = new Array<Claimer[] | undefined>(n);
    const role = (g: number): MaterialRole | undefined => src.defs.get(g)?.role;

    for (let i = 0; i < n; i++) {
      const dg = src.decor[i] ?? 0, wg = src.walls[i] ?? 0, gg = src.ground[i] ?? 0;
      const rd = role(dg), rw = role(wg), rg = role(gg);
      if (rw === "wall" || rg === "wall") { this.wall[i] = 1; this.wallGid[i] = rw === "wall" ? wg : gg; continue; }
      let terrain = 0;
      for (const [g, r] of [[dg, rd], [wg, rw], [gg, rg]] as const) {
        if (!g || !r || !FULL_ROLES.has(r)) continue;
        if (r === "door") { if (!this.doorGid[i]) this.doorGid[i] = g; continue; }
        if (!terrain) terrain = g; // decor over walls layer over ground
      }
      if (!terrain && !this.doorGid[i] && src.underlay >= 0) terrain = src.underlay;
      if (!terrain) continue;
      this.cellGid[i] = terrain;
      this.cellMat[i] = this.matIndex(terrain, src.defs);
      if (src.defs.get(terrain)?.role === "hazard") this.hazards.push({ x: i % src.w, y: Math.floor(i / src.w), gid: terrain });
    }
    // a door cell stands on the material of a neighboring cell (south first: that is the side the doorway faces)
    for (let i = 0; i < n; i++) {
      if (this.cellMat[i]! >= 0 || !this.doorGid[i] || this.wall[i]) continue;
      const x = i % src.w, y = Math.floor(i / src.w);
      for (const [dx, dy] of NEIGHBORS8.slice(0, 4).sort((a, b) => b[1] - a[1])) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= src.w || ny >= src.h) continue;
        const j = ny * src.w + nx;
        if (this.cellMat[j]! >= 0 && !this.doorGid[j]) { this.cellMat[i] = this.cellMat[j]!; this.cellGid[i] = this.cellGid[j]!; break; }
      }
    }
  }

  private matIndex(gid: number, defs: ReadonlyMap<number, TileDef>): number {
    const known = this.matOfGid.get(gid);
    if (known !== undefined) return known;
    const def = defs.get(gid)!;
    const key = materialKey(def);
    let idx = this.mats.findIndex((m) => m.key === key);
    if (idx < 0) {
      idx = this.mats.length;
      this.mats.push({
        idx, key, role: def.role, rank: matRank(def.role, def.walkable), tie: hashString(key),
        def, organic: ORGANIC_PATTERNS.has(def.pattern) || def.role === "liquid", liquid: def.role === "liquid", hazard: def.role === "hazard",
        reach: roleReach(def.role),
      });
    }
    this.matOfGid.set(gid, idx);
    return idx;
  }

  isWall(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h && this.wall[y * this.w + x] === 1;
  }

  matAt(x: number, y: number): number {
    return x < 0 || y < 0 || x >= this.w || y >= this.h ? -1 : this.cellMat[y * this.w + x]!;
  }

  /** The neighbors of a cell whose material is drawn over this cell's material, with their rects. */
  claimers(x: number, y: number): Claimer[] {
    const i = y * this.w + x;
    let c = this.claimCache[i];
    if (c) return c;
    c = [];
    const m = this.cellMat[i]!;
    if (m >= 0) {
      for (const [dx, dy] of NEIGHBORS8) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
        const j = ny * this.w + nx, nm = this.cellMat[j]!;
        if (nm < 0 || nm === m) continue;
        if (outranks(this.mats[nm]!, this.mats[m]!)) c.push({ mat: nm, gid: this.cellGid[j]!, rx: nx * T, ry: ny * T });
      }
    }
    this.claimCache[i] = c;
    return c;
  }

  /** The boundary wobble noise at a world pixel, in [0, 1). */
  reachNoise(wx: number, wy: number): number {
    return latticeNoise(this.seed + 7, REACH_SCALE, REACH_STEP, wx, wy);
  }

  /**
   * Owner of a world pixel. `out.mat` is -1 for walls and pixels off the map; `out.gid` the gid whose art to
   * sample; `out.rim` is set on the outermost pixel of a bleed, where a contact line is drawn. `noise` is the
   * reach noise at the pixel when the caller already has it (the chunk builder reads it from a precomputed field).
   */
  resolve(wx: number, wy: number, out: Owner, noise?: number): void {
    const tx = Math.floor(wx / T), ty = Math.floor(wy / T);
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) { out.rim = false; out.bled = false; out.mat = -1; out.gid = 0; return; }
    this.resolveIn(tx, ty, wx, wy, out, noise);
  }

  /** `resolve` for a pixel known to lie in cell (tx, ty). */
  resolveIn(tx: number, ty: number, wx: number, wy: number, out: Owner, noise?: number): void {
    const i = ty * this.w + tx;
    const m = this.cellMat[i]!;
    out.rim = false; out.bled = false;
    out.mat = m; out.gid = this.cellGid[i]!;
    if (m < 0) return;
    const cl = this.claimers(tx, ty);
    if (cl.length === 0) return;
    const n = noise ?? this.reachNoise(wx, wy);
    let best = m;
    for (const c of cl) {
      const info = this.mats[c.mat]!;
      const reach = info.reach.lo + (info.reach.hi - info.reach.lo) * n;
      const d = rectDist(wx, wy, c.rx, c.ry, T, T);
      if (d < reach && (best === m || outranks(info, this.mats[best]!))) {
        best = c.mat; out.mat = c.mat; out.gid = c.gid; out.bled = true;
        out.rim = d >= reach - 1 && !info.liquid;
      }
    }
  }

  /** Neighbors (non-liquid terrain) that reach into a wall cell when walls are rounded. */
  wallClaimers(x: number, y: number): Claimer[] {
    const i = y * this.w + x;
    let c = this.wallClaimCache.get(i);
    if (c) return c;
    c = [];
    for (const [dx, dy] of NEIGHBORS8) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
      const j = ny * this.w + nx, nm = this.cellMat[j]!;
      if (nm >= 0 && !this.mats[nm]!.liquid) c.push({ mat: nm, gid: this.cellGid[j]!, rx: nx * T, ry: ny * T });
    }
    this.wallClaimCache.set(i, c);
    return c;
  }

  /** Owner of a pixel of a wall cell when walls are rounded: the best neighbor whose reach covers it, else -1 (wall). */
  resolveWall(tx: number, ty: number, wx: number, wy: number, out: Owner, noise: number): void {
    out.mat = -1; out.gid = 0; out.rim = false; out.bled = false;
    for (const c of this.wallClaimers(tx, ty)) {
      const info = this.mats[c.mat]!;
      const reach = (info.reach.lo + (info.reach.hi - info.reach.lo) * noise) * 1.15;
      const d = rectDist(wx, wy, c.rx, c.ry, T, T);
      if (d < reach && (out.mat < 0 || outranks(info, this.mats[out.mat]!))) {
        out.mat = c.mat; out.gid = c.gid; out.bled = true; out.rim = d >= reach - 1;
      }
    }
  }

  /** True when the cell or any of its eight neighbors is a wall (so cast shadows may fall on it). */
  nearWall(x: number, y: number): boolean {
    for (let dy = -2; dy <= 0; dy++) for (let dx = -1; dx <= 1; dx++) if (this.isWall(x + dx, y + dy)) return true;
    return false;
  }
}
