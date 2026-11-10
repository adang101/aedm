import { T, arrangeRooms, blobShape, carveShapes, connectRooms, level, OBSTACLE_RATE, scatterObstacles } from "./grid";
import type { Grid, LayoutFn, RoomShape } from "./grid";

/** Walkable shallows around land, where there is something walkable to use. */
function ring(grid: Grid, rng: { chance(p: number): boolean }, shape: RoomShape): void {
  for (const t of shape.tiles) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = t.x + dx;
        const y = t.y + dy;
        if (!grid.inside(x, y) || grid.border(x, y)) continue;
        const i = grid.idx(x, y);
        if (grid.t[i] !== T.LIQUID) continue;
        const near = Math.max(Math.abs(dx), Math.abs(dy)) === 1;
        if (near || rng.chance(0.18)) grid.t[i] = T.SHALLOW;
      }
    }
  }
}

/** Liquid-filled map with islands for the brief's rooms, a few islets, shallows, and bridges between. */
export const islands: LayoutFn = ({ grid, setting, rooms, rng, hasShallow }) => {
  grid.fill(T.LIQUID);
  const shapes = arrangeRooms(grid, rooms, rng, "blob");
  const islets: RoomShape[] = [];
  const count = rng.int(1, 2) + level(setting.density.liquid);
  for (let k = 0; k < count; k++) {
    const cx = rng.int(4, grid.w - 5);
    const cy = rng.int(4, grid.h - 5);
    const r = rng.int(1, 2);
    const clear = (): boolean => {
      for (let y = cy - r - 2; y <= cy + r + 2; y++) for (let x = cx - r - 2; x <= cx + r + 2; x++) if (grid.get(x, y) !== T.LIQUID) return false;
      return true;
    };
    // islets are placed before rooms are carved, so check against the planned room boxes
    const overlaps = shapes.some((s) => cx + r + 3 > s.x0 && cx - r - 3 < s.x0 + s.w && cy + r + 3 > s.y0 && cy - r - 3 < s.y0 + s.h);
    if (overlaps || !clear()) continue;
    islets.push(blobShape(grid, rng, `islet_${k}`, "shore", cx, cy, r, r, true));
  }
  const all = [...shapes, ...islets];
  carveShapes(grid, all);
  if (hasShallow) for (const s of all) ring(grid, rng, s);
  connectRooms(grid, all, rooms, rng, 1, false);
  const land = (i: number) => grid.t[i] === T.FLOOR && !grid.crit[i] && grid.room[i]! >= 0;
  scatterObstacles(grid, rng, OBSTACLE_RATE[level(setting.density.obstacles)] * 1.5, land);
  return { shapes: all };
};
