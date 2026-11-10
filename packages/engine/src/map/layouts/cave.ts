import { OBSTACLE_RATE, T, arrangeRooms, caNoise, carveShapes, connectRooms, freeFloor, level, pond, scatterObstacles } from "./grid";
import type { LayoutFn } from "./grid";

/** Cellular-automata caverns with organic chambers for the brief's rooms, joined by jittered tunnels. */
export const cave: LayoutFn = ({ grid, setting, rooms, rng, hasShallow }) => {
  const mask = caNoise(grid, rng, 0.45, 4);
  for (let i = 0; i < mask.length; i++) grid.t[i] = mask[i] ? T.WALL : T.FLOOR;
  const shapes = arrangeRooms(grid, rooms, rng, "blob");
  carveShapes(grid, shapes);
  connectRooms(grid, shapes, rooms, rng, rng.chance(0.5) ? 2 : 1, false);

  scatterObstacles(grid, rng, OBSTACLE_RATE[level(setting.density.obstacles)], freeFloor(grid));
  const lakes = setting.density.liquid > 0 ? rng.int(1, level(setting.density.liquid) + 1) : 0;
  for (let k = 0; k < lakes; k++) {
    pond(grid, rng, rng.int(4, grid.w - 5), rng.int(4, grid.h - 5), rng.int(2, 3 + level(setting.density.liquid)), hasShallow, freeFloor(grid));
  }
  return { shapes };
};
