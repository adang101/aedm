import { TERRAIN, quantile } from "../fields";
import { addShallows, carveLakes, growVegetation, linkRooms, roomDistance } from "../nature";
import { T, arrangeRooms, carveShapes, level } from "./grid";
import type { LayoutFn } from "./grid";

/**
 * Carved caverns: rock is wherever the smooth grove field is high, so the open space is a few winding chambers with rounded
 * walls rather than speckle; the brief's rooms are organic hollows; tunnels are cut between them over a noise-perturbed
 * least-cost route (so they bend and reuse natural gaps); pools sit in open chambers with a rim of shallows; stalagmites cluster.
 */
export const cave: LayoutFn = ({ grid, setting, rooms, rng, hasShallow }) => {
  const C = TERRAIN.cave;
  const cut = quantile(grid.grove, C.openShare, (i) => !grid.border(i % grid.w, Math.floor(i / grid.w)));
  for (let i = 0; i < grid.t.length; i++) grid.t[i] = grid.grove[i]! < cut ? T.FLOOR : T.WALL;
  const shapes = arrangeRooms(grid, rooms, rng, "blob");
  carveShapes(grid, shapes);
  linkRooms(grid, shapes, rooms, 1.2, false);
  // some tunnels are two tiles wide where the field is high
  const base = grid.t.slice();
  for (let i = 0; i < base.length; i++) {
    if (base[i] !== T.PATH || grid.wander2[i]! < 0.62) continue;
    const j = i + 1;
    if (j % grid.w < grid.w - 1 && grid.t[j] === T.WALL) { grid.t[j] = T.PATH; grid.crit[j] = 1; }
  }

  const rd = roomDistance(grid);
  const open = (i: number): boolean => {
    if (grid.t[i] !== T.FLOOR || grid.crit[i] || rd[i]! < 1) return false;
    const x = i % grid.w;
    const y = Math.floor(i / grid.w);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (grid.get(x + dx, y + dy) !== T.FLOOR && grid.get(x + dx, y + dy) !== T.LIQUID) return false;
    return true;
  };
  carveLakes(grid, rng, level(setting.density.liquid), open);
  if (hasShallow) addShallows(grid);
  growVegetation(grid, rng, { level: level(setting.density.obstacles), shapes, scale: C.stalagmiteScale, noRocks: true, open: new Set([shapes[0]!.id]) });
  return { shapes };
};
