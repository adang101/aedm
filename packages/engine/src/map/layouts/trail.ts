import type { ExitSide } from "@aedm/schemas";
import type { MapRng } from "../prng";
import { TERRAIN, findRoute, quantile } from "../fields";
import { addShallows, carveLakes, carveRiver, growTreeline, growVegetation, layPath, pave, placeCover, roomDistance, widenPaths, wearLandmarks } from "../nature";
import { T, blobShape, carveShapes, level } from "./grid";
import type { Grid, LayoutFn, Pt, RoomShape } from "./grid";

function borderPoint(grid: Grid, rng: MapRng, side: ExitSide): Pt {
  const lo = 3;
  switch (side) {
    case "north": return { x: rng.int(lo, grid.w - 1 - lo), y: 0 };
    case "south": return { x: rng.int(lo, grid.w - 1 - lo), y: grid.h - 1 };
    case "west": return { x: 0, y: rng.int(lo, grid.h - 1 - lo) };
    default: return { x: grid.w - 1, y: rng.int(lo, grid.h - 1 - lo) };
  }
}

/** One step inside the border, so the trail meets the exit square-on. */
const inward = (grid: Grid, p: Pt): Pt => ({ x: Math.min(grid.w - 2, Math.max(1, p.x)), y: Math.min(grid.h - 2, Math.max(1, p.y)) });

/**
 * A winding trail between the exits through dense cover, with a clearing along it for each room (the party starts in the
 * first, near the way in). The trail follows a noise-perturbed least-cost route, so it bends round thickets, lakes and rocks;
 * a stream across it is bridged or forded. Thickets follow the grove field and leave glades where it is low.
 */
export const trail: LayoutFn = ({ grid, setting, rooms, exits, rng, hasShallow, hints }) => {
  grid.fill(T.FLOOR);
  const outdoor = setting.environment === "outdoor";
  const dense = level(setting.density.obstacles);
  // enclosed trails (cave passes, ravines) get their rock walls first, so the route has to find its way through
  if (!outdoor) {
    const cut = quantile(grid.grove, 1 - TERRAIN.vegetation.denseShare[dense]!, (i) => !grid.border(i % grid.w, Math.floor(i / grid.w)));
    for (let i = 0; i < grid.t.length; i++) if (grid.grove[i]! >= cut) grid.t[i] = T.WALL;
  }

  const ends: Pt[] = [];
  for (const e of exits) {
    let p = borderPoint(grid, rng, e.side);
    for (let k = 0; k < 12 && ends.some((q) => Math.max(Math.abs(q.x - p.x), Math.abs(q.y - p.y)) < 3); k++) p = borderPoint(grid, rng, e.side);
    ends.push(p);
  }
  const first = ends[0]!;
  // with one exit the trail starts at an interior point on the opposite side
  let start: Pt;
  let finish: Pt;
  if (exits.length >= 2) {
    start = inward(grid, first);
    finish = inward(grid, ends[1]!);
  } else {
    const opposite = { north: "south", south: "north", east: "west", west: "east" }[exits[0]!.side] as ExitSide;
    const far = borderPoint(grid, rng, opposite);
    start = { x: Math.min(grid.w - 3, Math.max(2, far.x)), y: Math.min(grid.h - 3, Math.max(2, far.y)) };
    finish = inward(grid, first);
  }

  // the main route first, as a plan: clearings go along it
  const wanderCost = (i: number): number => (grid.border(i % grid.w, Math.floor(i / grid.w)) ? Infinity : 1 + TERRAIN.paths.noiseCost * 1.6 * grid.wander[i]! + (grid.t[i] === T.WALL ? TERRAIN.paths.wallCost : 0));
  const plan = findRoute(grid.w, grid.h, grid.idx(start.x, start.y), grid.idx(finish.x, finish.y), wanderCost);
  const along = (f: number): Pt => {
    const c = plan[Math.min(plan.length - 1, Math.max(0, Math.round(f * (plan.length - 1))))]!;
    return { x: c % grid.w, y: Math.floor(c / grid.w) };
  };
  const shapes: RoomShape[] = [];
  const n = rooms.length;
  rooms.forEach((room, i) => {
    const at = along(n === 1 ? 0.5 : 0.1 + (0.8 * i) / (n - 1));
    const r = { small: 2, medium: 3, large: 4 }[room.size];
    shapes.push(blobShape(grid, rng, room.id, room.type, at.x, at.y, r + (n > 6 ? 0 : 1), r, false));
  });
  carveShapes(grid, shapes);

  // water, kept clear of the route and the clearings
  const lq = level(setting.density.liquid);
  const rd = roomDistance(grid);
  const onPlan = new Uint8Array(grid.w * grid.h);
  for (const c of plan) onPlan[c] = 1;
  const nearPlan = (i: number): boolean => {
    const x = i % grid.w;
    const y = Math.floor(i / grid.w);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (grid.inside(x + dx, y + dy) && onPlan[grid.idx(x + dx, y + dy)]) return true;
    return false;
  };
  carveLakes(grid, rng, lq, (i) => grid.t[i] === T.FLOOR && rd[i]! > TERRAIN.water.roomClearance && !nearPlan(i));
  carveRiver(grid, rng, lq, (i) => grid.t[i] === T.FLOOR || grid.t[i] === T.WALL, rd);
  if (hasShallow) addShallows(grid);

  // lay the trail over the planned route (bridging water it meets), then through every clearing
  const main = layPath(grid, grid.idx(start.x, start.y), grid.idx(finish.x, finish.y), 1.6);
  shapes.forEach((s) => {
    const nearest = main.reduce((best, c) => (Math.hypot((c % grid.w) - s.center.x, Math.floor(c / grid.w) - s.center.y) < Math.hypot((best % grid.w) - s.center.x, Math.floor(best / grid.w) - s.center.y) ? c : best), main[0]!);
    layPath(grid, nearest, grid.idx(s.center.x, s.center.y), 1);
  });

  const exitPoints: Array<Pt | undefined> = new Array(exits.length).fill(undefined);
  exits.forEach((_, i) => {
    const e = ends[i]!;
    const inn = inward(grid, e);
    if (i >= 2) {
      // side exits branch off the main path
      const from = main[rng.int(Math.floor(main.length / 4), main.length - 1)]!;
      layPath(grid, from, grid.idx(inn.x, inn.y), 1.2);
    } else {
      pave(grid, grid.idx(inn.x, inn.y));
    }
    const b = grid.idx(e.x, e.y);
    grid.t[b] = T.PATH;
    grid.crit[b] = 1;
    exitPoints[i] = e;
  });

  widenPaths(grid);
  wearLandmarks(grid, rng, shapes, hints?.focalRooms ?? new Set());
  if (outdoor) {
    growVegetation(grid, rng, { level: dense, dense: true, shapes, open: new Set(shapes.map((s) => s.id)), ...(hints ? { focal: hints.focalRooms } : {}) });
    shapes.forEach((s, k) => {
      if (hints?.combatRooms.has(s.id)) placeCover(grid, rng, s, k);
    });
    growTreeline(grid, rng);
  }
  return { shapes, exitPoints };
};
