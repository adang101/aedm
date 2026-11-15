/**
 * Pure helpers for the terrain renderer: stable hashing and value noise, the layering order between material
 * roles, how far a higher material reaches into a lower one, and which scattered details a material gets.
 * No DOM, no Math.random: everything is a function of (map seed, position, material).
 */
import type { MaterialRole, TileDef } from "@aedm/schemas";

/** 32-bit integer hash of a seed and two integers. */
export function hash2(seed: number, x: number, y: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(x | 0, 0xc2b2ae35) ^ Math.imul(y | 0, 0x27d4eb2f);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

/** Hash as a float in [0, 1). */
export function hash01(seed: number, x: number, y: number): number {
  return hash2(seed, x, y) / 4294967296;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Smooth value noise in [0, 1); (x, y) are in lattice units. */
export function noise2(seed: number, x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = smooth(x - x0), fy = smooth(y - y0);
  const a = hash01(seed, x0, y0), b = hash01(seed, x0 + 1, y0), c = hash01(seed, x0, y0 + 1), d = hash01(seed, x0 + 1, y0 + 1);
  const top = a + (b - a) * fx;
  return top + ((c + (d - c) * fx) - top) * fy;
}

/** Two octaves of value noise at a feature size of `scale` pixels, in [0, 1). */
export function fbm2(seed: number, px: number, py: number, scale: number): number {
  return 0.68 * noise2(seed, px / scale, py / scale) + 0.32 * noise2(seed + 101, px / (scale * 0.4), py / (scale * 0.4));
}

const bilerp = (a: number, b: number, c: number, d: number, fx: number, fy: number): number => {
  const top = a + (b - a) * fx;
  return top + ((c + (d - c) * fx) - top) * fy;
};

/** `fbm2` sampled on a lattice of `step` pixels and bilinearly interpolated: a cheap smooth field, identical wherever it is evaluated. */
export function latticeNoise(seed: number, scale: number, step: number, wx: number, wy: number): number {
  const gx = wx / step, gy = wy / step;
  const ix = Math.floor(gx), iy = Math.floor(gy);
  const f = (x: number, y: number) => fbm2(seed, x * step, y * step, scale);
  return bilerp(f(ix, iy), f(ix + 1, iy), f(ix, iy + 1), f(ix + 1, iy + 1), gx - ix, gy - iy);
}

/** The same field as `latticeNoise`, precomputed over a pixel rectangle so a chunk can read it per pixel cheaply. */
export class LatticeField {
  private v: Float64Array;
  private gx0: number;
  private gy0: number;
  private gw: number;
  constructor(seed: number, scale: number, private step: number, x0: number, y0: number, w: number, h: number) {
    this.gx0 = Math.floor(x0 / step); this.gy0 = Math.floor(y0 / step);
    this.gw = Math.floor((x0 + w) / step) - this.gx0 + 2;
    const gh = Math.floor((y0 + h) / step) - this.gy0 + 2;
    this.v = new Float64Array(this.gw * gh);
    for (let j = 0; j < gh; j++) for (let i = 0; i < this.gw; i++) this.v[j * this.gw + i] = fbm2(seed, (this.gx0 + i) * step, (this.gy0 + j) * step, scale);
  }
  at(wx: number, wy: number): number {
    const gx = wx / this.step, gy = wy / this.step;
    const ix = Math.floor(gx), iy = Math.floor(gy);
    const o = (iy - this.gy0) * this.gw + (ix - this.gx0);
    return bilerp(this.v[o]!, this.v[o + 1]!, this.v[o + this.gw]!, this.v[o + this.gw + 1]!, gx - ix, gy - iy);
  }
}

/**
 * Layering order of the ground roles: a higher number is drawn over a lower one where they meet.
 * Liquid sits lowest (the bank overlaps the shore), then floor, path and hazard. Doors, walls and props are
 * not part of the ground blend.
 */
export const ROLE_RANK: Readonly<Record<MaterialRole, number>> = {
  liquid: 0, floor: 1, path: 2, hazard: 3, door: 4, wall: -1, obstacle: -1, decor: -1,
};

export interface Rankable { rank: number; tie: number }

/** The rank of a material: its role, with the blocking variant of a role (deep water) above the walkable one. */
export function matRank(role: MaterialRole, walkable: boolean): number {
  return ROLE_RANK[role] * 10 + (walkable ? 0 : 5);
}

/** True when `a` is drawn over `b` where they meet. Total order: rank, then a stable tie-break value. */
export function outranks(a: Rankable, b: Rankable): boolean {
  return a.rank !== b.rank ? a.rank > b.rank : a.tie > b.tie;
}

/** Two tiles are the same material when nothing about their look differs except the variant. */
export function materialKey(def: Pick<TileDef, "material_id" | "color" | "accent" | "pattern" | "role">): string {
  return `${def.material_id}|${def.role}|${def.color}|${def.accent}|${def.pattern}`.toLowerCase();
}

/** How far (px) the boundary of a higher material may reach into the lower cell: low..high of the wobble. */
export function roleReach(role: MaterialRole): { lo: number; hi: number } {
  switch (role) {
    case "hazard": return { lo: 1, hi: 4 };
    case "liquid": return { lo: 2, hi: 11 };
    default: return { lo: 3, hi: 16 };
  }
}

/** Distance in pixels from a point to an axis-aligned rectangle (0 inside). */
export function rectDist(px: number, py: number, rx: number, ry: number, rw: number, rh: number): number {
  const dx = Math.max(rx - px, 0, px - (rx + rw - 1));
  const dy = Math.max(ry - py, 0, py - (ry + rh - 1));
  return Math.sqrt(dx * dx + dy * dy);
}

/** The eight neighbor offsets, edges first. */
export const NEIGHBORS8: readonly (readonly [number, number])[] = [
  [0, -1], [1, 0], [0, 1], [-1, 0], [-1, -1], [1, -1], [1, 1], [-1, 1],
];

/** Patterns whose texture has no structure, so it can be sampled at warped offsets without showing a grid. */
export const ORGANIC_PATTERNS: ReadonlySet<string> = new Set(["grass", "sand", "speckle", "dots", "none", "cracks", "grain"]);

export type ScatterKind = "pebble" | "crack" | "sparkle" | "flower";

/** Scattered details a ground material gets, chosen from its role, pattern and the words in its id (tiles carry no tags). */
export function scatterKinds(def: Pick<TileDef, "role" | "pattern" | "material_id">): ScatterKind[] {
  if (def.role !== "floor" && def.role !== "path") return [];
  const id = def.material_id.toLowerCase();
  const snowy = /snow|ice|frost|glacier|white/.test(id);
  const out: ScatterKind[] = [];
  if (snowy) out.push("sparkle");
  if (def.pattern === "grass" && !snowy) out.push("flower");
  if (["grass", "sand", "speckle", "dots", "none"].includes(def.pattern) && !snowy) out.push("pebble");
  if (["tiles", "bricks", "cobbles", "planks"].includes(def.pattern) || (def.pattern !== "cracks" && /stone|rock|flag|marble|slab/.test(id))) out.push("crack");
  return out;
}
