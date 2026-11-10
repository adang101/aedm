import { T, arrangeRooms, caNoise, carveShapes, connectRooms, level, pond } from "./grid";
import type { LayoutFn } from "./grid";

const CLUMP = [0, 0.3, 0.4, 0.46] as const;
const SINGLES = [0, 0.01, 0.015, 0.02] as const;

/** Open ground with obstacle clumps by density, ponds, and cleared rooms joined by painted paths. */
export const openField: LayoutFn = ({ grid, setting, rooms, rng, hasShallow }) => {
  const d = level(setting.density.obstacles);
  grid.fill(T.FLOOR);
  if (d > 0) {
    const mask = caNoise(grid, rng, CLUMP[d], 3);
    for (let i = 0; i < mask.length; i++) if (mask[i]) grid.t[i] = T.OBSTACLE;
    for (let i = 0; i < mask.length; i++) if (grid.t[i] === T.FLOOR && rng.chance(SINGLES[d])) grid.t[i] = T.OBSTACLE;
  }
  const lq = level(setting.density.liquid);
  const ponds = lq === 0 ? 0 : rng.int(lq, lq * 2);
  const any = (i: number) => !grid.border(i % grid.w, Math.floor(i / grid.w));
  for (let k = 0; k < ponds; k++) pond(grid, rng, rng.int(3, grid.w - 4), rng.int(3, grid.h - 4), rng.int(2, 2 + lq), hasShallow, (i) => any(i) && (grid.t[i] === T.FLOOR || grid.t[i] === T.OBSTACLE));

  const shapes = arrangeRooms(grid, rooms, rng, "blob");
  carveShapes(grid, shapes);
  connectRooms(grid, shapes, rooms, rng, 1, true);
  return { shapes };
};
