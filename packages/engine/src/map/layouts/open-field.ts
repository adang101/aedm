import { addShallows, carveLakes, carveRiver, growTreeline, growVegetation, layPath, linkRooms, openExit, placeCover, roomDistance, widenPaths, wearLandmarks } from "../nature";
import { TERRAIN } from "../fields";
import { T, arrangeRooms, carveShapes, level } from "./grid";
import type { LayoutFn, Pt } from "./grid";

/**
 * Open ground as a place: clearings for the rooms, lakes in low ground and sometimes a winding river, winding paths between
 * the rooms and out to the exits (bridged or forded where they cross water), worn ground at the arrival point and landmarks,
 * groves that follow the terrain fields, and a treeline instead of a fence.
 */
export const openField: LayoutFn = ({ grid, setting, rooms, exits, rng, hasShallow, hints }) => {
  grid.fill(T.FLOOR);
  const shapes = arrangeRooms(grid, rooms, rng, "blob", TERRAIN.rooms.fieldScale);
  carveShapes(grid, shapes);

  const lq = level(setting.density.liquid);
  const rd = roomDistance(grid);
  const open = (i: number): boolean => grid.t[i] === T.FLOOR && rd[i]! > TERRAIN.water.roomClearance;
  carveLakes(grid, rng, lq, open);
  carveRiver(grid, rng, lq, (i) => grid.t[i] === T.FLOOR, rd);
  if (hasShallow) addShallows(grid);

  linkRooms(grid, shapes, rooms);
  const exitPoints: Pt[] = [];
  for (const e of exits) exitPoints.push(openExit(grid, rng, e.side, shapes, exitPoints));
  // an extra trail between the first room and the farthest one gives a loop where there are enough rooms
  if (shapes.length >= 4) layPath(grid, grid.idx(shapes[0]!.center.x, shapes[0]!.center.y), grid.idx(shapes[shapes.length - 1]!.center.x, shapes[shapes.length - 1]!.center.y), 1.4);
  widenPaths(grid);
  wearLandmarks(grid, rng, shapes, hints?.focalRooms ?? new Set());

  growVegetation(grid, rng, { level: level(setting.density.obstacles), shapes, open: new Set([shapes[0]!.id, ...(hints?.combatRooms ?? [])]), ...(hints ? { focal: hints.focalRooms } : {}) });
  shapes.forEach((s, k) => {
    if (!s.extra && hints?.combatRooms.has(s.id)) placeCover(grid, rng, s, k);
  });
  if (setting.environment === "outdoor") growTreeline(grid, rng);
  return { shapes, exitPoints };
};
