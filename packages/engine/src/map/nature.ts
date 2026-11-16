/**
 * Natural-terrain toolkit for the layout generators: seeded fields, lakes and rivers, least-cost paths, worn ground,
 * groves, treelines, cover, and coherent ground-material zones. Every random choice comes from the MapRng passed in or from
 * the seeded fields; every number comes from data/terrain.json. Pure and deterministic.
 */
import type { ExitSide, Room } from "@aedm/schemas";
import type { MapRng } from "./prng";
import { TERRAIN, findRoute, makeField, quantile, smoothstep } from "./fields";
import { DIRS4, T } from "./layouts/grid";
import type { Grid, Pt, RoomShape, Terrain } from "./layouts/grid";
import type { ResolvedSetting } from "./settings";

const DIRS8: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

const xOf = (grid: Grid, i: number): number => i % grid.w;
const yOf = (grid: Grid, i: number): number => Math.floor(i / grid.w);
const isBorder = (grid: Grid, i: number): boolean => grid.border(xOf(grid, i), yOf(grid, i));
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

// ---------- fields ----------

/** Fills the grid's elevation, moisture, grove and wander fields from the seed (not from the map rng, so layouts keep their own streams). */
export function computeFields(grid: Grid, seed: number): void {
  const F = TERRAIN.fields;
  const { w, h } = grid;
  grid.elev.set(makeField(w, h, seed ^ 0x1a2b3c, F.elevation));
  const m = makeField(w, h, seed ^ 0x4d5e6f, F.moisture);
  const k = F.moistureFromLowGround;
  for (let i = 0; i < m.length; i++) grid.moist[i] = (1 - k) * m[i]! + k * (1 - grid.elev[i]!);
  grid.grove.set(makeField(w, h, seed ^ 0x7a8b9c, F.grove));
  grid.wander.set(makeField(w, h, seed ^ 0x0d1e2f, F.wander));
  grid.wander2.set(makeField(w, h, seed ^ 0x3a4b5c, F.wander2));
}

/** Chebyshev distance from every tile to the nearest source tile, capped at `max` + 1. */
export function distanceField(grid: Grid, isSource: (i: number) => boolean, max: number): Int16Array {
  const dist = new Int16Array(grid.w * grid.h).fill(max + 1);
  const queue: number[] = [];
  for (let i = 0; i < dist.length; i++) if (isSource(i)) { dist[i] = 0; queue.push(i); }
  for (let q = 0; q < queue.length; q++) {
    const c = queue[q]!;
    const d = dist[c]!;
    if (d >= max) continue;
    const x = xOf(grid, c);
    const y = yOf(grid, c);
    for (const [dx, dy] of DIRS8) {
      const nx = x + dx;
      const ny = y + dy;
      if (!grid.inside(nx, ny)) continue;
      const n = grid.idx(nx, ny);
      if (dist[n]! > d + 1) { dist[n] = d + 1; queue.push(n); }
    }
  }
  return dist;
}

/** Distance to the nearest tile of a brief room (0 inside one). */
export const roomDistance = (grid: Grid, max = 8): Int16Array => distanceField(grid, (i) => grid.room[i]! >= 0, max);

// ---------- water ----------

const neighbours8 = (grid: Grid, mask: Uint8Array, x: number, y: number): number => {
  let n = 0;
  for (const [dx, dy] of DIRS8) if (grid.inside(x + dx, y + dy) && mask[grid.idx(x + dx, y + dy)]) n++;
  return n;
};

/** Majority smoothing on a water mask, only where `ok`: rounds corners, fills notches, drops spurs. */
function smoothMask(grid: Grid, mask: Uint8Array, ok: (i: number) => boolean, passes: number, keep: number): void {
  for (let p = 0; p < passes; p++) {
    const next = mask.slice();
    for (let i = 0; i < mask.length; i++) {
      if (!ok(i)) continue;
      const n = neighbours8(grid, mask, xOf(grid, i), yOf(grid, i));
      next[i] = mask[i] ? (n >= keep ? 1 : 0) : n >= 5 ? 1 : 0;
    }
    mask.set(next);
  }
}

/** Removes 4-connected components smaller than `min`. */
function dropSmall(grid: Grid, mask: Uint8Array, min: number): void {
  const seen = new Uint8Array(mask.length);
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    const comp = [s];
    seen[s] = 1;
    for (let q = 0; q < comp.length; q++) {
      const c = comp[q]!;
      for (const [dx, dy] of DIRS4) {
        const nx = xOf(grid, c) + dx;
        const ny = yOf(grid, c) + dy;
        if (!grid.inside(nx, ny)) continue;
        const n = grid.idx(nx, ny);
        if (mask[n] && !seen[n]) { seen[n] = 1; comp.push(n); }
      }
    }
    if (comp.length < min) for (const c of comp) mask[c] = 0;
  }
}

const margin = (grid: Grid, i: number, m: number): boolean => {
  const x = xOf(grid, i);
  const y = yOf(grid, i);
  return x >= m && y >= m && x < grid.w - m && y < grid.h - m;
};

/**
 * Lakes and ponds in low ground: each grows outward from a low point, cheapest (lowest, roundest) tiles first, so the
 * shoreline is irregular but smooth. `ok` says which tiles water may take. Returns the number of lakes made.
 */
export function carveLakes(grid: Grid, rng: MapRng, lvl: number, ok: (i: number) => boolean): number {
  const W = TERRAIN.water;
  if (lvl <= 0) return 0;
  const usable = (i: number): boolean => margin(grid, i, W.borderMargin) && ok(i);
  const count = rng.int(1, W.lakeCount[lvl]!);
  const total = W.lakeShare[lvl]! * (grid.w - 2) * (grid.h - 2) * (0.8 + rng.next() * 0.4);
  const water = new Uint8Array(grid.w * grid.h);
  let made = 0;
  for (let k = 0; k < count; k++) {
    // the lowest usable tile with room around it, with a little seeded jitter so lakes are not always in the same valley
    let best = -1;
    let bestV = Infinity;
    for (let i = 0; i < water.length; i++) {
      if (water[i] || !usable(i)) continue;
      const v = grid.elev[i]! + rng.next() * 0.12;
      if (v >= bestV) continue;
      let room = 0;
      for (const [dx, dy] of DIRS8) if (grid.inside(xOf(grid, i) + dx, yOf(grid, i) + dy) && usable(grid.idx(xOf(grid, i) + dx, yOf(grid, i) + dy))) room++;
      if (room >= 7) { best = i; bestV = v; }
    }
    if (best < 0) break;
    const target = Math.max(W.lakeMin + 2, Math.round((total / count) * (0.7 + rng.next() * 0.6)));
    const cx = xOf(grid, best);
    const cy = yOf(grid, best);
    // a pond: a tilted ellipse whose edge is pushed in and out by the wander field, so the shore is round and irregular, never stepped
    const aspect = W.pondAspect[0]! + rng.next() * (W.pondAspect[1]! - W.pondAspect[0]!);
    const ang = rng.next() * Math.PI;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const R = Math.sqrt((target * aspect) / Math.PI);
    const reach = Math.ceil(R / Math.min(aspect, 1) + 2);
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (!grid.inside(x, y)) continue;
        const n = grid.idx(x, y);
        if (!usable(n)) continue;
        const u = dx * ca + dy * sa;
        const v = -dx * sa + dy * ca;
        const e = Math.hypot(u / (R / aspect), v / R);
        if (e <= 1 + W.pondWobble * (grid.wander2[n]! - 0.5)) water[n] = 1;
      }
    }
    made++;
  }
  smoothMask(grid, water, usable, W.smoothPasses, 3);
  dropSmall(grid, water, W.lakeMin);
  for (let i = 0; i < water.length; i++) if (water[i] && usable(i)) { grid.t[i] = T.LIQUID; grid.veg[i] = 0; }
  return made;
}

/**
 * A river that winds from one side of the map to the opposite one over a noise-perturbed cost field, avoiding clearings,
 * with a width that swells and narrows. Returns true when one was made. Routes laid later bridge or ford it where they must cross.
 */
export function carveRiver(grid: Grid, rng: MapRng, lvl: number, ok: (i: number) => boolean, roomDist: Int16Array): boolean {
  const W = TERRAIN.water;
  if (lvl <= 0 || !rng.chance(W.riverChance[lvl]!)) return false;
  if (Math.max(grid.w, grid.h) < W.riverMinSpan) return false;
  const horizontal = grid.w >= grid.h ? !rng.chance(0.2) : rng.chance(0.2);
  const along = horizontal ? grid.w : grid.h;
  const across = horizontal ? grid.h : grid.w;
  const cell = (u: number, v: number): number => (horizontal ? grid.idx(u, v) : grid.idx(v, u));
  // of a few straight candidates, take the one that crosses the least clearing, so the river does not have to hug a room
  let a = 0;
  let b = 0;
  let bestCost = Infinity;
  for (let k = 0; k < W.riverCandidates; k++) {
    const ca = Math.round(across * (0.2 + rng.next() * 0.6));
    const cb = Math.round(across * (0.2 + rng.next() * 0.6));
    let c = 0;
    for (let u = 1; u < along - 1; u++) {
      const v = Math.round(ca + ((cb - ca) * (u - 1)) / (along - 3));
      c += roomDist[cell(u, v)]! <= W.riverRoomPad ? 1 : 0;
    }
    if (c < bestCost) { bestCost = c; a = ca; b = cb; }
  }
  const from = cell(1, a);
  const to = cell(along - 2, b);
  const route = windingRoute(grid, from, to, W.riverAmp, (i) => {
    if (isBorder(grid, i) || !ok(i)) return Infinity;
    const rd = roomDist[i]!;
    const nearRoom = rd <= W.riverRoomPad ? W.riverRoomCost / (1 + rd) : 0;
    return 1 + W.riverNoiseCost * grid.wander2[i]! ** 2 + nearRoom;
  });
  if (route.length < along / 2) return false;
  const water = new Uint8Array(grid.w * grid.h);
  // the banks are a distance threshold around a smoothed centre line (not circles stamped on a staircase of cells), so
  // they curve; the radius swells and narrows with the wander field and the edge itself wobbles a little
  const half = W.riverSmooth;
  const pts = route.map((c, k) => {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let j = Math.max(0, k - half); j <= Math.min(route.length - 1, k + half); j++) { sx += xOf(grid, route[j]!); sy += yOf(grid, route[j]!); n++; }
    return { x: sx / n, y: sy / n, r: W.riverRadiusBase + W.riverRadiusExtra * smoothstep(0.25, 0.75, grid.wander[c]!) };
  });
  for (let k = 0; k + 1 < pts.length; k++) {
    const p = pts[k]!;
    const q = pts[k + 1]!;
    const reach = Math.ceil(Math.max(p.r, q.r) + 1.5);
    const x0 = Math.floor(Math.min(p.x, q.x)) - reach;
    const x1 = Math.ceil(Math.max(p.x, q.x)) + reach;
    const y0 = Math.floor(Math.min(p.y, q.y)) - reach;
    const y1 = Math.ceil(Math.max(p.y, q.y)) + reach;
    const sx = q.x - p.x;
    const sy = q.y - p.y;
    const len2 = sx * sx + sy * sy || 1;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!grid.inside(x, y) || grid.border(x, y)) continue;
        const n = grid.idx(x, y);
        if (water[n] || !ok(n) || roomDist[n]! <= 0) continue;
        const t = Math.min(1, Math.max(0, ((x - p.x) * sx + (y - p.y) * sy) / len2));
        const d = Math.hypot(x - (p.x + sx * t), y - (p.y + sy * t));
        const r = p.r + (q.r - p.r) * t + W.riverEdgeWobble * (grid.wander2[n]! - 0.5);
        if (d <= r) water[n] = 1;
      }
    }
  }
  smoothMask(grid, water, (i) => ok(i) && !isBorder(grid, i) && roomDist[i]! > 0, 1, 2);
  for (let i = 0; i < water.length; i++) if (water[i]) { grid.t[i] = T.LIQUID; grid.veg[i] = 0; }
  return true;
}

/** Open-water pools smaller than `min` tiles become `instead` (shallows or land), so water never shows as a lone square. */
export function fillSmallWater(grid: Grid, min: number, instead: Terrain): void {
  const mask = new Uint8Array(grid.w * grid.h);
  for (let i = 0; i < mask.length; i++) if (grid.t[i] === T.LIQUID && !isBorder(grid, i)) mask[i] = 1;
  const before = mask.slice();
  dropSmall(grid, mask, min);
  for (let i = 0; i < mask.length; i++) if (before[i] && !mask[i]) grid.t[i] = instead;
}

/** A ring of walkable shallows around open water, one tile wide and sometimes two (wider where the wander field is high). */
export function addShallows(grid: Grid): void {
  const W = TERRAIN.water;
  const d = distanceField(grid, (i) => grid.t[i] === T.LIQUID, W.shallowRingFar);
  for (let i = 0; i < d.length; i++) {
    if (grid.t[i] !== T.FLOOR || grid.crit[i] || isBorder(grid, i)) continue;
    const di = d[i]!;
    if (di >= 1 && (di <= W.shallowRingNear || (di <= W.shallowRingFar && grid.wander[i]! > W.shallowFarThreshold))) grid.t[i] = T.SHALLOW;
  }
}

// ---------- paths ----------

/** The cost of walking onto a tile when laying a path: cheap on existing path, dear through trees, walls and water. */
function pathCostFn(grid: Grid, noise = 1): (i: number) => number {
  const P = TERRAIN.paths;
  return (i) => {
    const x = xOf(grid, i);
    const y = yOf(grid, i);
    if (grid.border(x, y)) return Infinity;
    const t = grid.t[i]!;
    if (t === T.PATH || t === T.BRIDGE || t === T.DOOR) return P.pathCost;
    let c = P.baseCost + P.noiseCost * noise * grid.wander[i]! ** P.noiseExponent;
    if (grid.room[i]! >= 0) c *= 0.6;
    if (t === T.SHALLOW) c += P.shallowCost;
    else if (t === T.LIQUID) c += P.liquidCost;
    else if (t === T.OBSTACLE) c += P.obstacleCost;
    else if (t === T.WALL) c += P.wallCost;
    else {
      for (const [dx, dy] of DIRS4) if (grid.get(x + dx, y + dy) === T.LIQUID) { c += P.nearWaterCost; break; }
    }
    return c;
  };
}

/** Lays one route cell as walkable ground: floor and solids become path, open water a bridge, shallows stay a ford. The tile is kept clear. */
export function pave(grid: Grid, i: number, paintFloor = true): void {
  grid.crit[i] = 1;
  const t = grid.t[i]!;
  if (t === T.LIQUID) grid.t[i] = T.BRIDGE;
  else if (t === T.WALL || t === T.OBSTACLE || t === T.HAZARD || (t === T.FLOOR && paintFloor)) { grid.t[i] = T.PATH; grid.veg[i] = 0; }
}

export const centerIdx = (grid: Grid, s: RoomShape): number => grid.idx(s.center.x, s.center.y);

/** Routes and paves a path between two tiles over the noise-perturbed cost field. `noise` scales the perturbation (more is more winding). */
export function layPath(grid: Grid, from: number, to: number, noise = 1, paintFloor = true): number[] {
  const route = windingRoute(grid, from, to, TERRAIN.paths.waypointAmp * noise, pathCostFn(grid, noise));
  for (const c of route) pave(grid, c, paintFloor);
  return route;
}

/**
 * Intermediate stops between two tiles, pushed sideways (alternately left and right) by the wander field, so a route through
 * them bends in long smooth swings instead of running ruler-straight along one valley of the cost field.
 */
function waypoints(grid: Grid, from: number, to: number, amp: number): number[] {
  const x0 = xOf(grid, from);
  const y0 = yOf(grid, from);
  const x1 = xOf(grid, to);
  const y1 = yOf(grid, to);
  const len = Math.hypot(x1 - x0, y1 - y0);
  const n = amp <= 0 ? 0 : Math.min(TERRAIN.paths.waypointMax, Math.floor(len / TERRAIN.paths.waypointSpacing));
  const pts = [from];
  const px = -(y1 - y0) / (len || 1);
  const py = (x1 - x0) / (len || 1);
  for (let k = 1; k <= n; k++) {
    const t = k / (n + 1);
    const mx = x0 + (x1 - x0) * t;
    const my = y0 + (y1 - y0) * t;
    const m = grid.idx(Math.round(mx), Math.round(my));
    const side = (grid.wander[m]! > 0.5 ? 1 : -1) * (k % 2 === 1 ? 1 : -1);
    const off = side * amp * len * (0.55 + Math.abs(grid.wander2[m]! - 0.5));
    const wx = Math.min(grid.w - 3, Math.max(2, Math.round(mx + px * off)));
    const wy = Math.min(grid.h - 3, Math.max(2, Math.round(my + py * off)));
    pts.push(grid.idx(wx, wy));
  }
  pts.push(to);
  return pts;
}

/** A least-cost route through the waypoints. */
function windingRoute(grid: Grid, from: number, to: number, amp: number, cost: (i: number) => number): number[] {
  const stops = waypoints(grid, from, to, amp);
  const out: number[] = [];
  for (let k = 1; k < stops.length; k++) {
    const seg = findRoute(grid.w, grid.h, stops[k - 1]!, stops[k]!, cost);
    if (seg.length === 0) return findRoute(grid.w, grid.h, from, to, cost);
    for (let j = out.length > 0 ? 1 : 0; j < seg.length; j++) out.push(seg[j]!);
  }
  return out;
}

/** Joins the brief's rooms along `connects_to`, then any leftover pieces, with winding paths between their centers. */
export function linkRooms(grid: Grid, shapes: readonly RoomShape[], rooms: readonly Room[], noise = 1, paintFloor = true): void {
  const ix = new Map(shapes.map((s, i) => [s.id, i]));
  const parent = shapes.map((_, i) => i);
  const find = (a: number): number => (parent[a] === a ? a : (parent[a] = find(parent[a]!)));
  const link = (a: number, b: number): void => {
    parent[find(a)] = find(b);
    layPath(grid, centerIdx(grid, shapes[a]!), centerIdx(grid, shapes[b]!), noise, paintFloor);
  };
  const done = new Set<string>();
  rooms.forEach((room, a) => {
    for (const target of room.connects_to) {
      const b = ix.get(target);
      if (b === undefined || b === a) continue;
      const k = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (done.has(k)) continue;
      done.add(k);
      link(a, b);
    }
  });
  let prev = 0;
  for (let i = 1; i < shapes.length; i++) {
    if (find(i) !== find(prev)) link(prev, i);
    prev = i;
  }
}

/** Border tile and the tile just inside it for an exit on `side`, near `along` (a coordinate along that side). */
function exitTile(grid: Grid, side: ExitSide, along: number): { border: Pt; inner: Pt } {
  const lo = 3;
  const cx = Math.min(grid.w - 1 - lo, Math.max(lo, along));
  const cy = Math.min(grid.h - 1 - lo, Math.max(lo, along));
  switch (side) {
    case "north": return { border: { x: cx, y: 0 }, inner: { x: cx, y: 1 } };
    case "south": return { border: { x: cx, y: grid.h - 1 }, inner: { x: cx, y: grid.h - 2 } };
    case "west": return { border: { x: 0, y: cy }, inner: { x: 1, y: cy } };
    default: return { border: { x: grid.w - 1, y: cy }, inner: { x: grid.w - 2, y: cy } };
  }
}

/**
 * Opens one exit on `side`: a path from the nearest room (by that side) out to a border tile, which is returned already opened.
 * Exits keep at least 3 tiles apart where the side allows.
 */
export function openExit(grid: Grid, rng: MapRng, side: ExitSide, shapes: readonly RoomShape[], taken: readonly Pt[]): Pt {
  const key = (p: Pt): number => (side === "north" ? p.y : side === "south" ? grid.h - 1 - p.y : side === "west" ? p.x : grid.w - 1 - p.x);
  const real = shapes.filter((s) => !s.extra);
  const near = [...real].sort((a, b) => key(a.center) - key(b.center))[0]!;
  const horizontalSide = side === "north" || side === "south";
  const jitter = TERRAIN.paths.exitJitter;
  let pick = exitTile(grid, side, (horizontalSide ? near.center.x : near.center.y) + rng.int(-jitter, jitter));
  for (let k = 0; k < 12 && taken.some((q) => Math.max(Math.abs(q.x - pick.border.x), Math.abs(q.y - pick.border.y)) < 3); k++) {
    pick = exitTile(grid, side, rng.int(3, (horizontalSide ? grid.w : grid.h) - 4));
  }
  layPath(grid, centerIdx(grid, near), grid.idx(pick.inner.x, pick.inner.y));
  const b = grid.idx(pick.border.x, pick.border.y);
  grid.t[b] = T.PATH;
  grid.crit[b] = 1;
  grid.veg[b] = 0;
  return pick.border;
}

/** Widens the path network: wider stretches where the wander field is high, and worn ground around junctions. */
export function widenPaths(grid: Grid): void {
  const P = TERRAIN.paths;
  const base = grid.t.slice();
  const hashed = (i: number, k: number): number => ((Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(k + 1, 0x85ebca6b)) >>> 0) / 4294967296;
  for (let i = 0; i < base.length; i++) {
    if (base[i] !== T.PATH || isBorder(grid, i)) continue;
    const x = xOf(grid, i);
    const y = yOf(grid, i);
    let around = 0;
    for (const [dx, dy] of DIRS4) if (grid.inside(x + dx, y + dy) && base[grid.idx(x + dx, y + dy)] === T.PATH) around++;
    const wear = (nx: number, ny: number): void => {
      if (!grid.inside(nx, ny) || grid.border(nx, ny)) return;
      const n = grid.idx(nx, ny);
      if (grid.t[n] === T.FLOOR && grid.room[n]! < 0) grid.t[n] = T.PATH;
    };
    if (around >= P.junctionNeighbors && hashed(i, 1) < P.junctionChance) for (const [dx, dy] of DIRS8) wear(x + dx, y + dy);
    else if (grid.wander2[i]! > P.wideFieldThreshold && hashed(i, 2) < P.wideChance) {
      const [dx, dy] = DIRS4[Math.floor(hashed(i, 3) * 4)]!;
      wear(x + dx, y + dy);
    }
  }
}

/** A patch of worn ground (path material) with an irregular edge, for arrival areas and landmarks. Floor only; never touches water, trees or room clearings' water. */
export function wornPatch(grid: Grid, cx: number, cy: number, radius: number): void {
  const wob = TERRAIN.paths.landmarkWobble;
  const reach = Math.ceil(radius + 1);
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (!grid.inside(x, y) || grid.border(x, y)) continue;
      const i = grid.idx(x, y);
      const r = radius * (1 + wob * (grid.wander2[i]! - 0.5));
      if (dx * dx + dy * dy <= r * r && grid.t[i] === T.FLOOR) grid.t[i] = T.PATH;
    }
  }
}

/** Worn ground at the arrival point and at every focal room's center. */
export function wearLandmarks(grid: Grid, rng: MapRng, shapes: readonly RoomShape[], focal: ReadonlySet<string>): void {
  const P = TERRAIN.paths;
  const first = shapes[0];
  if (first) wornPatch(grid, first.center.x, first.center.y, P.startRadius);
  for (const s of shapes) {
    if (s.extra || !focal.has(s.id)) continue;
    wornPatch(grid, s.center.x, s.center.y, P.landmarkRadius[0]! + rng.next() * (P.landmarkRadius[1]! - P.landmarkRadius[0]!));
  }
}

// ---------- vegetation ----------

export interface VegetationOpts {
  /** Density level 0..3. */
  level: number;
  /** Forest-like cover (trails): uses the dense shares. */
  dense?: boolean;
  /** Room ids that are focal (they keep a clear core of ground around their center). */
  focal?: ReadonlySet<string>;
  /** Room ids kept entirely open: the arrival area and the combat rooms. */
  open?: ReadonlySet<string>;
  /** Scales the grove share and the scatter rate (caves: sparse stalagmites). Default 1. */
  scale?: number;
  /** No rock outcrops or lone boulders (towns: clusters and street props only). */
  noRocks?: boolean;
  shapes: readonly RoomShape[];
}

const species = (grid: Grid, i: number): number => (grid.moist[i]! > 0.5 ? 2 : 1);

/**
 * Groves, thickets and outcrops that follow the terrain fields, leaving clearings around rooms and focal areas and keeping
 * routes clear. Obstacles carry a species code (`grid.veg`) so a grove is one kind of tree and rocks gather on high ground.
 */
export function growVegetation(grid: Grid, rng: MapRng, opts: VegetationOpts): void {
  const V = TERRAIN.vegetation;
  const lvl = opts.level;
  if (lvl <= 0) return;
  // clearings: whole rooms for the arrival area and combat, a core around the center of focal rooms, a small one elsewhere
  const keep = new Uint8Array(grid.w * grid.h);
  const wholly = new Uint8Array(grid.w * grid.h);
  opts.shapes.forEach((s, k) => {
    const all = opts.open?.has(s.id) === true;
    const core = opts.focal?.has(s.id) ? Math.max(V.focalCoreMin, V.focalCore * Math.min(s.w, s.h) * 0.5) : V.roomCore;
    for (const t of s.tiles) {
      const i = grid.idx(t.x, t.y);
      if (grid.room[i] !== k) continue;
      if (all) { keep[i] = 1; wholly[i] = 1; }
      else if (Math.hypot(t.x - s.center.x, t.y - s.center.y) <= core) keep[i] = 1;
    }
  });
  const near = distanceField(grid, (i) => wholly[i] === 1, V.clearingPad);
  const cand = (i: number): boolean => grid.t[i] === T.FLOOR && !grid.crit[i] && !isBorder(grid, i) && !keep[i] && near[i]! > V.clearingPad;
  const put = (i: number, code: number): void => { grid.t[i] = T.OBSTACLE; grid.veg[i] = code; };

  if (!opts.noRocks) {
    const rockCut = quantile(grid.elev, 1 - V.outcropShare[lvl]!, cand);
    for (let i = 0; i < grid.t.length; i++) if (cand(i) && grid.elev[i]! >= rockCut && rng.chance(V.outcropFill)) put(i, 3);
  }

  const share = (opts.dense ? V.denseShare[lvl]! : V.groveShare[lvl]!) * (opts.scale ?? 1);
  const cut = quantile(grid.grove, 1 - share, cand);
  for (let i = 0; i < grid.t.length; i++) {
    if (!cand(i)) continue;
    const s = grid.grove[i]!;
    if (s >= cut && rng.chance(V.groveFill * smoothstep(0, V.groveEdge, (s - cut) / (1 - cut + 1e-6)))) put(i, species(grid, i));
  }

  const rate = V.scatter[lvl]! * (opts.scale ?? 1);
  if (rate > 0) {
    for (let i = 0; i < grid.t.length; i++) if (cand(i) && rng.chance(rate)) put(i, !opts.noRocks && rng.chance(V.scatterRockShare) ? 3 : species(grid, i));
  }
}

/** The outdoor boundary: a dense treeline whose depth follows the grove field, feathering into the interior. Sets species on the border tiles too. */
export function growTreeline(grid: Grid, rng: MapRng): void {
  const L = TERRAIN.treeline;
  for (let y = 0; y < grid.h; y++) {
    for (let x = 0; x < grid.w; x++) {
      const d = Math.min(x, y, grid.w - 1 - x, grid.h - 1 - y);
      if (d > L.maxThickness + 1) continue;
      const i = grid.idx(x, y);
      // the field sampled on the border itself, so a stretch of boundary is uniformly thick or thin
      const bx = d === x ? 0 : d === grid.w - 1 - x ? grid.w - 1 : x;
      const by = d === y ? 0 : d === grid.h - 1 - y ? grid.h - 1 : y;
      const f = grid.grove[grid.idx(Math.min(grid.w - 1, Math.max(0, bx)), Math.min(grid.h - 1, Math.max(0, by)))]!;
      const thick = L.minThickness + Math.round((L.maxThickness - L.minThickness) * clamp01((f - L.thinBelow) / (L.thickAbove - L.thinBelow)));
      if (d === 0) { grid.veg[i] = species(grid, i); continue; }
      if (grid.t[i] !== T.FLOOR || grid.crit[i] || grid.room[i]! >= 0) continue;
      if (d <= thick ? rng.chance(L.fill) : d === thick + 1 && rng.chance(L.feather * f)) {
        grid.t[i] = T.OBSTACLE;
        grid.veg[i] = species(grid, i);
      }
    }
  }
}

/** A few boulders around the rim of a combat room: cover to fight around, with open ground in the middle. */
export function placeCover(grid: Grid, rng: MapRng, shape: RoomShape, index: number): void {
  const C = TERRAIN.vegetation.cover;
  const n = rng.int(C.count[0]!, C.count[1]!);
  const rx = shape.w / 2;
  const ry = shape.h / 2;
  const off = rng.next() * Math.PI * 2;
  for (let k = 0; k < n; k++) {
    const a = off + (k / n) * Math.PI * 2 + (rng.next() - 0.5) * 0.6;
    const r = C.ringMin + rng.next() * (C.ringMax - C.ringMin);
    const x = Math.round(shape.center.x + Math.cos(a) * rx * r);
    const y = Math.round(shape.center.y + Math.sin(a) * ry * r);
    if (!grid.inside(x, y) || Math.hypot(x - shape.center.x, y - shape.center.y) < C.minFromCenter) continue;
    const i = grid.idx(x, y);
    if (grid.t[i] !== T.FLOOR || grid.crit[i] || grid.room[i] !== index) continue;
    grid.t[i] = T.OBSTACLE;
    grid.veg[i] = 3;
  }
}

// ---------- ground zones ----------

/** Cells whose ground is drawn from the setting's floor materials. */
const zonable = (grid: Grid, i: number, shallowMats: boolean): boolean => {
  const t = grid.t[i]!;
  return t === T.FLOOR || t === T.OBSTACLE || t === T.LIQUID || (t === T.SHALLOW && !shallowMats);
};

/** Reassigns zone patches smaller than `min` tiles (and lone specks) to the zone they mostly touch, until nothing small is left. */
function removeSmallPatches(grid: Grid, ok: (i: number) => boolean, min: number): void {
  for (let round = 0; round < 4; round++) {
    const label = new Int32Array(grid.w * grid.h).fill(-1);
    let changed = false;
    for (let s = 0; s < label.length; s++) {
      if (label[s]! >= 0 || !ok(s)) continue;
      const zone = grid.zone[s]!;
      const comp = [s];
      label[s] = s;
      for (let q = 0; q < comp.length; q++) {
        const c = comp[q]!;
        for (const [dx, dy] of DIRS4) {
          const nx = xOf(grid, c) + dx;
          const ny = yOf(grid, c) + dy;
          if (!grid.inside(nx, ny)) continue;
          const n = grid.idx(nx, ny);
          if (label[n]! < 0 && ok(n) && grid.zone[n] === zone) { label[n] = s; comp.push(n); }
        }
      }
      if (comp.length >= min) continue;
      const votes = [0, 0, 0, 0];
      for (const c of comp) {
        for (const [dx, dy] of DIRS4) {
          const nx = xOf(grid, c) + dx;
          const ny = yOf(grid, c) + dy;
          if (!grid.inside(nx, ny)) continue;
          const n = grid.idx(nx, ny);
          if (ok(n) && grid.zone[n] !== zone) votes[grid.zone[n]!]!++;
        }
      }
      let best = -1;
      for (let z = 0; z < votes.length; z++) if (z !== zone && votes[z]! > 0 && (best < 0 || votes[z]! > votes[best]!)) best = z;
      if (best >= 0) { for (const c of comp) grid.zone[c] = best; changed = true; }
    }
    if (!changed) break;
  }
}

function majority(grid: Grid, ok: (i: number) => boolean, passes: number): void {
  for (let p = 0; p < passes; p++) {
    const next = grid.zone.slice();
    for (let i = 0; i < next.length; i++) {
      if (!ok(i)) continue;
      const counts = [0, 0, 0, 0];
      let total = 0;
      for (const [dx, dy] of DIRS8) {
        const x = xOf(grid, i) + dx;
        const y = yOf(grid, i) + dy;
        if (!grid.inside(x, y)) continue;
        const n = grid.idx(x, y);
        if (ok(n)) { counts[grid.zone[n]!]!++; total++; }
      }
      let best = grid.zone[i]!;
      for (let z = 0; z < counts.length; z++) if (counts[z]! > counts[best]!) best = z;
      if (best !== grid.zone[i] && counts[best]! * 2 > total) next[i] = best;
    }
    grid.zone.set(next);
  }
}

/**
 * Chooses the floor material of every ground tile so secondary materials form contiguous, organic regions: damp ground
 * (moisture field, also near water) takes the second material, grove floors the third, beaches and worn ground follow
 * water and paths. Patches smaller than the data's minimum are absorbed, so there are no isolated specks.
 */
export function paintGround(grid: Grid, setting: ResolvedSetting, mode: "fields" | "shore" | "worn"): void {
  const floors = setting.materials.floor.length;
  grid.zone.fill(0);
  if (floors <= 1) return;
  const shallowMats = setting.materials.liquid.some((m) => m.walkable);
  const ok = (i: number): boolean => zonable(grid, i, shallowMats);
  const G = TERRAIN.ground;
  const params = setting.environment === "outdoor" ? G.outdoor : G.built;
  if (mode === "shore" || mode === "worn") {
    const spec = mode === "shore" ? G.shore : G.worn;
    const d = distanceField(grid, mode === "shore" ? (i) => grid.t[i] === T.LIQUID || grid.t[i] === T.SHALLOW : (i) => grid.t[i] === T.PATH || grid.t[i] === T.DOOR, spec.radius + 2);
    for (let i = 0; i < d.length; i++) if (ok(i) && d[i]! <= spec.radius + spec.radiusWobble * (grid.wander2[i]! - 0.5) * 2 && d[i]! > (mode === "worn" ? 0 : -1)) grid.zone[i] = 1;
  } else {
    const wet = distanceField(grid, (i) => grid.t[i] === T.LIQUID, 3);
    const eff = new Float32Array(grid.zone.length);
    for (let i = 0; i < eff.length; i++) eff[i] = grid.moist[i]! + (wet[i]! <= 3 ? (TERRAIN.water.riverBankMoisture * (4 - wet[i]!)) / 3 : 0);
    const cutM = quantile(eff, 1 - params.secondaryShare, ok);
    for (let i = 0; i < eff.length; i++) if (ok(i) && eff[i]! >= cutM) grid.zone[i] = 1;
    if (floors >= 3 && params.tertiaryShare > 0) {
      const mix = new Float32Array(eff.length);
      for (let i = 0; i < mix.length; i++) mix[i] = params.tertiaryFromGrove * grid.grove[i]! + (1 - params.tertiaryFromGrove) * (1 - grid.moist[i]!);
      const cutG = quantile(mix, 1 - params.tertiaryShare, (i) => ok(i) && grid.zone[i] === 0);
      for (let i = 0; i < mix.length; i++) if (ok(i) && grid.zone[i] === 0 && mix[i]! >= cutG) grid.zone[i] = 2;
    }
  }
  majority(grid, ok, params.smoothPasses);
  removeSmallPatches(grid, ok, params.minPatch);
}

/** Where a tile of the given grove value takes decor: denser in groves, sparse in the open. */
export const decorWeight = (grove: number): number => TERRAIN.decor.groveMin + (TERRAIN.decor.groveMax - TERRAIN.decor.groveMin) * clamp01(grove);
