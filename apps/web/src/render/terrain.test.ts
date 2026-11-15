import { describe, expect, it } from "vitest";
import type { TileDef } from "@aedm/schemas";
import { TerrainGrid, T, type Owner } from "./terrain-grid";
import {
  LatticeField, ROLE_RANK, fbm2, hash01, hash2, latticeNoise, matRank, materialKey, noise2, outranks, rectDist, roleReach, scatterKinds,
} from "./terrain-math";

const def = (gid: number, material_id: string, role: TileDef["role"], over: Partial<TileDef> = {}): TileDef => ({
  gid, material_id, role, color: "#4f8a3c", accent: "#7cb342", pattern: "grass", walkable: role !== "wall", blocks_sight: role === "wall",
  variant: 0, layer: role === "wall" ? "walls" : "ground", ...over,
});

const GRASS = def(1, "grass", "floor");
const GRASS_V1 = def(2, "grass", "floor", { variant: 1 });
const DIRT = def(3, "dirt", "path", { color: "#9a6a3f", pattern: "speckle" });
const WATER = def(4, "shallow_water", "liquid", { color: "#4f9fe0", pattern: "waves" });
const DEEP = def(5, "deep_water", "liquid", { color: "#2f6bb5", pattern: "waves", walkable: false });
const WALL = def(6, "wall", "wall", { color: "#5c6380", pattern: "bricks" });
const DOOR = def(7, "door", "door", { color: "#9a6a3f", pattern: "planks" });
const DEFS = new Map([GRASS, GRASS_V1, DIRT, WATER, DEEP, WALL, DOOR].map((d) => [d.gid, d]));

function grid(rows: string[], map: Record<string, number>, over: { walls?: string[]; roundWalls?: boolean } = {}): TerrainGrid {
  const h = rows.length, w = rows[0]!.length;
  const flat = (r: string[]) => r.flatMap((row) => [...row].map((ch) => map[ch] ?? 0));
  return new TerrainGrid({
    mapId: "m_test", w, h, ground: flat(rows), walls: over.walls ? flat(over.walls) : new Array<number>(w * h).fill(0), decor: new Array<number>(w * h).fill(0),
    defs: DEFS, underlay: 1, roundWalls: over.roundWalls,
  });
}

const owner = (): Owner => ({ mat: -1, gid: 0, rim: false, bled: false });

describe("hashing and noise", () => {
  it("is deterministic and spreads over [0, 1)", () => {
    expect(hash2(7, 3, 4)).toBe(hash2(7, 3, 4));
    expect(hash2(7, 3, 4)).not.toBe(hash2(8, 3, 4));
    expect(hash2(7, 3, 4)).not.toBe(hash2(7, 4, 3));
    let lo = 1, hi = 0;
    for (let i = 0; i < 2000; i++) { const v = hash01(1, i, i * 3); lo = Math.min(lo, v); hi = Math.max(hi, v); }
    expect(lo).toBeGreaterThanOrEqual(0); expect(hi).toBeLessThan(1);
    expect(hi - lo).toBeGreaterThan(0.9);
  });
  it("noise is smooth, bounded and stable", () => {
    for (let i = 0; i < 300; i++) {
      const v = fbm2(5, i * 3.7, i * 1.3, 14);
      expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1);
    }
    expect(noise2(3, 2.5, 7.25)).toBe(noise2(3, 2.5, 7.25));
    expect(Math.abs(noise2(3, 5.0, 5.0) - noise2(3, 5.01, 5.0))).toBeLessThan(0.02);
  });
  it("a precomputed lattice field equals the direct function at every pixel", () => {
    const f = new LatticeField(9, 14, 2, -1, 95, 100, 60);
    for (const [x, y] of [[-1, 95], [0, 100], [37, 120], [98, 154], [50, 111]] as const) expect(f.at(x, y)).toBeCloseTo(latticeNoise(9, 14, 2, x, y), 10);
  });
});

describe("layering order", () => {
  it("ranks liquid under floor under path under hazard", () => {
    expect(ROLE_RANK.liquid).toBeLessThan(ROLE_RANK.floor);
    expect(ROLE_RANK.floor).toBeLessThan(ROLE_RANK.path);
    expect(ROLE_RANK.path).toBeLessThan(ROLE_RANK.hazard);
  });
  it("puts blocking deep water over walkable shallows and breaks ties by a stable value", () => {
    expect(matRank("liquid", false)).toBeGreaterThan(matRank("liquid", true));
    const a = { rank: 10, tie: 5 }, b = { rank: 10, tie: 9 };
    expect(outranks(b, a)).toBe(true);
    expect(outranks(a, b)).toBe(false);
    expect(outranks(a, a)).toBe(false);
    expect(outranks({ rank: 20, tie: 0 }, { rank: 10, tie: 99 })).toBe(true);
  });
  it("treats variants of one material as the same material", () => {
    expect(materialKey(GRASS)).toBe(materialKey(GRASS_V1));
    expect(materialKey(GRASS)).not.toBe(materialKey(DIRT));
    expect(materialKey({ ...GRASS, color: "#2f5d34" })).not.toBe(materialKey(GRASS));
  });
  it("keeps hazards tight and others wide", () => {
    expect(roleReach("hazard").hi).toBeLessThan(roleReach("floor").hi);
  });
});

describe("geometry", () => {
  it("measures distance to a tile rect", () => {
    expect(rectDist(10, 10, 0, 0, T, T)).toBe(0);
    expect(rectDist(T + 3, 10, 0, 0, T, T)).toBe(4); // first pixel outside is x = 48
    expect(rectDist(-3, -4, 0, 0, T, T)).toBe(5);
  });
});

describe("terrain grid", () => {
  const g = grid(["GGPP", "GGPP", "GGWW"], { G: 1, P: 3, W: 4 });

  it("gives variants one material and different materials different ones", () => {
    const v = grid(["GgP"], { G: 1, g: 2, P: 3 });
    expect(v.matAt(0, 0)).toBe(v.matAt(1, 0));
    expect(v.matAt(1, 0)).not.toBe(v.matAt(2, 0));
  });

  it("lets the higher material claim pixels in the lower cell only, never the other way", () => {
    const o = owner();
    const grass = g.matAt(0, 0), path = g.matAt(2, 0);
    // deep inside each cell nothing changes
    g.resolve(T * 0 + 5, 20, o); expect(o.mat).toBe(grass);
    g.resolve(T * 3 + 20, 20, o); expect(o.mat).toBe(path);
    // the path never loses pixels of its own cell, wherever it sits
    for (let y = 0; y < 2 * T; y += 3) for (let x = 2 * T; x < 4 * T; x += 3) { g.resolve(x, y, o); expect(o.mat).toBe(path); }
    // next to the border some grass pixels are claimed by the path, within the maximum reach
    let claimed = 0, farthest = 0;
    for (let x = T; x < 2 * T; x++) { for (let y = 0; y < T; y += 4) { g.resolve(x, y, o); if (o.mat === path) { claimed++; farthest = Math.max(farthest, 2 * T - x); } } }
    expect(claimed).toBeGreaterThan(0);
    expect(farthest).toBeLessThanOrEqual(roleReach("path").hi + 1);
    // and the boundary wobbles: the reach is not the same along the border
    const reaches = new Set<number>();
    for (let y = 0; y < T; y++) { let r = 0; for (let x = 2 * T - 1; x >= T; x--) { g.resolve(x, y, o); if (o.mat === path) r++; else break; } reaches.add(r); }
    expect(reaches.size).toBeGreaterThan(3);
  });

  it("draws the same thing every time and on every grid built from the same map", () => {
    const g2 = grid(["GGPP", "GGPP", "GGWW"], { G: 1, P: 3, W: 4 });
    const a = owner(), b = owner();
    for (let i = 0; i < 400; i++) {
      const x = (i * 37) % (4 * T), y = (i * 53) % (3 * T);
      g.resolve(x, y, a); g2.resolve(x, y, b);
      expect(a).toEqual(b);
    }
    const other = new TerrainGrid({ mapId: "m_other", w: 4, h: 3, ground: [1, 1, 3, 3, 1, 1, 3, 3, 1, 1, 4, 4], walls: new Array<number>(12).fill(0), decor: new Array<number>(12).fill(0), defs: DEFS, underlay: 1 });
    let differs = 0;
    for (let x = T; x < 2 * T; x++) { g.resolve(x, 20, a); other.resolve(x, 20, b); if (a.mat !== b.mat) differs++; }
    expect(differs).toBeGreaterThan(0); // a different map id wobbles differently
  });

  it("leaves walls opaque and out of the blend, and unrounded unless asked", () => {
    const w = grid(["GGPP", "GGPP", "GGGG"], { G: 1, P: 3, W: 6 }, { walls: ["....", "....", "..WW"] });
    expect(w.wall[2 * 4 + 2]).toBe(1);
    expect(w.matAt(2, 2)).toBe(-1);
    const o = owner();
    w.resolve(2 * T + 5, 2 * T + 5, o);
    expect(o.mat).toBe(-1);
    expect(w.roundWalls).toBe(false);
  });

  it("lets ground reach into rock walls when walls are rounded", () => {
    const r = grid(["GGG", "GGG", "GGG"], { G: 1 }, { walls: ["WWW", "...", "..."], roundWalls: true });
    const o = owner();
    let reached = 0;
    for (let x = 0; x < 3 * T; x++) for (let y = 0; y < T; y++) { r.resolveWall(Math.floor(x / T), 0, x, y, o, r.reachNoise(x, y)); if (o.mat >= 0) reached++; }
    expect(reached).toBeGreaterThan(0);
    r.resolveWall(1, 0, T + 24, 4, o, 0.5);
    expect(o.mat).toBe(-1); // the middle of the rock is untouched
  });

  it("puts a doorway on the material beside it and uses the underlay under props", () => {
    const d = grid(["GGG", "GDG", "GGG"], { G: 1, D: 7 });
    expect(d.doorGid[4]).toBe(7);
    expect(d.matAt(1, 1)).toBe(d.matAt(0, 0));
    const u = grid(["G.G"], { G: 1 });
    expect(u.matAt(1, 0)).toBe(u.matAt(0, 0)); // empty ground takes the underlay
  });

  it("keeps liquids as one material per gid and ranks deep over shallow", () => {
    const l = grid(["WWDD"], { W: 4, D: 5 });
    expect(l.matAt(0, 0)).not.toBe(l.matAt(2, 0));
    const o = owner();
    let deepWins = 0;
    for (let x = T; x < 2 * T; x++) { l.resolve(x, 10, o); if (o.mat === l.matAt(2, 0)) deepWins++; }
    expect(deepWins).toBeGreaterThan(0);
    for (let x = 2 * T; x < 4 * T; x++) { l.resolve(x, 10, o); expect(o.mat).toBe(l.matAt(2, 0)); }
  });
});

describe("scattered details", () => {
  it("chooses details by role, pattern and material words", () => {
    expect(scatterKinds({ role: "floor", pattern: "grass", material_id: "meadow_grass" })).toContain("flower");
    expect(scatterKinds({ role: "path", pattern: "speckle", material_id: "dirt_path" })).toContain("pebble");
    expect(scatterKinds({ role: "floor", pattern: "tiles", material_id: "marble_floor" })).toContain("crack");
    expect(scatterKinds({ role: "floor", pattern: "speckle", material_id: "snow" })).toEqual(["sparkle"]);
    expect(scatterKinds({ role: "liquid", pattern: "waves", material_id: "water" })).toEqual([]);
    expect(scatterKinds({ role: "wall", pattern: "bricks", material_id: "wall" })).toEqual([]);
  });
});
