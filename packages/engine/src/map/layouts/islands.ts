import { TERRAIN, findRoute } from "../fields";
import { distanceField, fillSmallWater, pave } from "../nature";
import { T, arrangeRooms, blobShape, carveShapes, level } from "./grid";
import type { Grid, LayoutFn, RoomShape } from "./grid";

const idx = (grid: Grid, p: { x: number; y: number }): number => grid.idx(p.x, p.y);

/**
 * Sea with islands: each room is the heart of an island whose coast is grown outward over the elevation and wander fields
 * (so shorelines are rounded and irregular, with coves and headlands), a few islets, shallows hugging every shore, and
 * crossings (sandbars through the shallows, plank bridges across deep water) joining the islands. Palms and rocks gather
 * inland in clusters.
 */
export const islands: LayoutFn = ({ grid, setting, rooms, rng, hasShallow }) => {
  const I = TERRAIN.islands;
  grid.fill(T.LIQUID);
  const shapes = arrangeRooms(grid, rooms, rng, "blob");
  const islets: RoomShape[] = [];
  const count = rng.int(1, 2) + level(setting.density.liquid);
  for (let k = 0; k < count; k++) {
    const cx = rng.int(4, grid.w - 5);
    const cy = rng.int(4, grid.h - 5);
    const r = rng.int(1, 2);
    // islets are placed before rooms are carved, so check against the planned room boxes
    const overlaps = shapes.some((s) => cx + r + 4 > s.x0 && cx - r - 4 < s.x0 + s.w && cy + r + 4 > s.y0 && cy - r - 4 < s.y0 + s.h);
    const near = islets.some((s) => Math.hypot(s.center.x - cx, s.center.y - cy) < r + 6);
    if (overlaps || near) continue;
    islets.push(blobShape(grid, rng, `islet_${k}`, "shore", cx, cy, r, r, true));
  }
  const all = [...shapes, ...islets];
  carveShapes(grid, all);

  // grow the coastline: land stretches a little way past each island's rooms, further where the field is high
  const core = distanceField(grid, (i) => grid.t[i] === T.FLOOR, I.grow[1]! + I.growWobble + 1);
  const land = new Uint8Array(grid.w * grid.h);
  for (let i = 0; i < land.length; i++) {
    if (grid.border(i % grid.w, Math.floor(i / grid.w))) continue;
    const reach = I.grow[0]! + (I.grow[1]! - I.grow[0]!) * grid.elev[i]! + I.growWobble * (grid.grove[i]! - 0.5);
    if (grid.t[i] === T.FLOOR || core[i]! <= reach) land[i] = 1;
  }
  // round the coast and fill lagoons too small to read as water
  for (let p = 0; p < I.smoothPasses; p++) {
    const next = land.slice();
    for (let i = 0; i < land.length; i++) {
      const x = i % grid.w;
      const y = Math.floor(i / grid.w);
      if (grid.border(x, y) || grid.t[i] === T.FLOOR) continue;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && land[grid.idx(x + dx, y + dy)]) n++;
      next[i] = land[i] ? (n >= 3 ? 1 : 0) : n >= 5 ? 1 : 0;
    }
    land.set(next);
  }
  for (let i = 0; i < land.length; i++) if (land[i] && grid.t[i] === T.LIQUID) grid.t[i] = T.FLOOR;

  if (hasShallow) {
    // shallows hug every shore, one tile wide and sometimes two
    const d = distanceField(grid, (i) => grid.t[i] === T.FLOOR, 2);
    for (let i = 0; i < d.length; i++) {
      if (grid.t[i] !== T.LIQUID || grid.border(i % grid.w, Math.floor(i / grid.w))) continue;
      if (d[i] === 1 || (d[i] === 2 && grid.wander[i]! > 0.45)) grid.t[i] = T.SHALLOW;
    }
  }

  fillSmallWater(grid, I.lagoonMin, hasShallow ? T.SHALLOW : T.FLOOR);

  // crossings: cheap through shallows (sandbars), dear across deep water (plank bridges)
  const cost = (i: number): number => {
    if (grid.border(i % grid.w, Math.floor(i / grid.w))) return Infinity;
    const t = grid.t[i]!;
    if (t === T.FLOOR || t === T.PATH || t === T.BRIDGE) return 0.5;
    if (t === T.SHALLOW) return I.shallowCost + grid.wander2[i]!;
    return I.bridgeCost + grid.wander2[i]!;
  };
  const ix = new Map(all.map((s, i) => [s.id, i]));
  const parent = all.map((_, i) => i);
  const find = (a: number): number => (parent[a] === a ? a : (parent[a] = find(parent[a]!)));
  const link = (a: number, b: number): void => {
    parent[find(a)] = find(b);
    for (const c of findRoute(grid.w, grid.h, idx(grid, all[a]!.center), idx(grid, all[b]!.center), cost)) pave(grid, c);
  };
  const done = new Set<string>();
  rooms.forEach((room, a) => {
    for (const target of room.connects_to) {
      const b = ix.get(target);
      if (b === undefined || b === a) continue;
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (done.has(key)) continue;
      done.add(key);
      link(a, b);
    }
  });
  let prev = 0;
  for (let i = 1; i < all.length; i++) {
    if (find(i) !== find(prev)) link(prev, i);
    prev = i;
  }

  // palms and rocks inland, in clusters; the beach stays open
  const inland = distanceField(grid, (i) => grid.t[i] === T.LIQUID || grid.t[i] === T.SHALLOW, I.palmInset + 1);
  const lvl = level(setting.density.obstacles);
  const share = TERRAIN.vegetation.groveShare[lvl]! * 1.6;
  const free = (i: number): boolean => grid.t[i] === T.FLOOR && !grid.crit[i] && inland[i]! > I.palmInset;
  const shares: number[] = [];
  for (let i = 0; i < grid.t.length; i++) if (free(i)) shares.push(grid.grove[i]!);
  shares.sort((a, b) => a - b);
  const cut = shares.length > 0 ? shares[Math.min(shares.length - 1, Math.floor((1 - share) * shares.length))]! : 2;
  if (lvl > 0) {
    for (let i = 0; i < grid.t.length; i++) {
      if (free(i) && grid.grove[i]! >= cut && rng.chance(0.8)) { grid.t[i] = T.OBSTACLE; grid.veg[i] = grid.elev[i]! > 0.7 ? 3 : 1; }
      else if (free(i) && rng.chance(TERRAIN.vegetation.scatter[lvl]!)) { grid.t[i] = T.OBSTACLE; grid.veg[i] = rng.chance(0.5) ? 3 : 1; }
    }
  }
  return { shapes: all };
};
