import type { ExitSide } from "@aedm/schemas";
import type { MapRng } from "../prng";
import { T, blobShape, caNoise, carveShapes, level } from "./grid";
import type { Grid, LayoutFn, Pt, RoomShape } from "./grid";

const DENSE = [0.4, 0.46, 0.5, 0.54] as const;

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

/** A winding 4-connected line from a to b: the straight line plus smooth sideways drift that fades at both ends. */
export function windingPath(grid: Grid, rng: MapRng, a: Pt, b: Pt): Pt[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.max(1, Math.hypot(dx, dy));
  const px = -dy / len;
  const py = dx / len;
  const amp = Math.min(grid.w, grid.h) * (0.1 + rng.next() * 0.1);
  const f1 = 1 + rng.next() * 1.5;
  const f2 = 2.5 + rng.next() * 2;
  const p1 = rng.next() * Math.PI * 2;
  const p2 = rng.next() * Math.PI * 2;
  const steps = Math.max(8, Math.round(len));
  const pts: Pt[] = [];
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const fade = Math.sin(Math.PI * t);
    const off = fade * (amp * Math.sin(2 * Math.PI * f1 * t + p1) + amp * 0.35 * Math.sin(2 * Math.PI * f2 * t + p2));
    const x = Math.round(a.x + dx * t + px * off);
    const y = Math.round(a.y + dy * t + py * off);
    pts.push({ x: Math.min(grid.w - 2, Math.max(1, x)), y: Math.min(grid.h - 2, Math.max(1, y)) });
  }
  pts[0] = a;
  pts[pts.length - 1] = b;
  return pts;
}

/** A winding walkable trail between the exits through dense obstacles, with clearings along it for the rooms. */
export const trail: LayoutFn = ({ grid, setting, rooms, exits, rng }) => {
  const solid = setting.environment === "outdoor" ? T.OBSTACLE : T.WALL;
  const mask = caNoise(grid, rng, DENSE[level(setting.density.obstacles)], 3);
  for (let i = 0; i < mask.length; i++) grid.t[i] = mask[i] ? solid : T.FLOOR;

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
  const main = windingPath(grid, rng, start, finish);

  // clearings along the main path, in brief order
  const shapes: RoomShape[] = [];
  const n = rooms.length;
  rooms.forEach((room, i) => {
    const at = main[Math.min(main.length - 1, Math.floor(((i + 0.5) / n) * main.length))]!;
    const r = { small: 2, medium: 3, large: 4 }[room.size];
    shapes.push(blobShape(grid, rng, room.id, room.type, at.x, at.y, r + (n > 6 ? 0 : 1), r, false));
  });
  carveShapes(grid, shapes);
  grid.polyline(main, 1, true);
  // widen the trail in places so it reads as a road, not a thread
  for (let i = 0; i < main.length; i++) if (rng.chance(0.25)) grid.carve(main[i]!.x + 1, main[i]!.y, true);

  const exitPoints: Array<Pt | undefined> = new Array(exits.length).fill(undefined);
  exits.forEach((_, i) => {
    const e = ends[i]!;
    const inn = inward(grid, e);
    if (i >= 2) {
      // side exits branch off the main path
      const from = main[rng.int(Math.floor(main.length / 4), main.length - 1)]!;
      grid.polyline(windingPath(grid, rng, from, inn), 1, true);
    }
    grid.carve(inn.x, inn.y, true);
    grid.carve(e.x, e.y, false, true);
    grid.t[grid.idx(e.x, e.y)] = T.PATH;
    exitPoints[i] = e;
  });
  return { shapes, exitPoints };
};
