import { OBSTACLE_RATE, T, arrangeRooms, carveShapes, connectRooms, freeFloor, level, pond, scatterObstacles } from "./grid";
import type { LayoutFn } from "./grid";

/** Rectangular rooms (caves stay organic) in a sea of wall, joined by 1-wide corridors with doors. */
export const roomsAndCorridors: LayoutFn = ({ grid, setting, rooms, rng, hasShallow }) => {
  grid.fill(T.WALL);
  const shapes = arrangeRooms(grid, rooms, rng, "rect");
  carveShapes(grid, shapes);
  connectRooms(grid, shapes, rooms, rng, 1, false);

  const inRoom = (i: number) => grid.t[i] === T.FLOOR && !grid.crit[i] && grid.room[i]! >= 0 && !grid.border(i % grid.w, Math.floor(i / grid.w));
  scatterObstacles(grid, rng, OBSTACLE_RATE[level(setting.density.obstacles)], inRoom);
  const pools = setting.density.liquid > 0 ? rng.int(1, level(setting.density.liquid)) : 0;
  for (let k = 0; k < pools; k++) {
    const s = shapes[rng.int(0, shapes.length - 1)]!;
    pond(grid, rng, s.center.x + rng.int(-1, 1), s.center.y + rng.int(-1, 1), rng.int(1, 2), hasShallow, freeFloor(grid));
  }
  return { shapes, doors: true };
};
