import { TERRAIN } from "../fields";
import { addShallows, carveLakes, carveRiver, growTreeline, growVegetation, linkRooms, openExit, roomDistance, widenPaths } from "../nature";
import { DIRS4, T, arrangeRooms, carveShapes, level } from "./grid";
import type { Grid, LayoutFn, Pt } from "./grid";

const PLAZA_TYPES = new Set(["outdoor", "courtyard", "street", "deck", "hall", "chamber", "vault"]);

/** Distance (4-connected, through open ground) from every tile to the nearest PATH tile. */
function pathDistance(grid: Grid): Int16Array {
  const dist = new Int16Array(grid.w * grid.h).fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < grid.t.length; i++) if (grid.t[i] === T.PATH) { dist[i] = 0; queue.push(i); }
  for (let q = 0; q < queue.length; q++) {
    const c = queue[q]!;
    const x = c % grid.w;
    const y = (c - x) / grid.w;
    for (const [dx, dy] of DIRS4) {
      const nx = x + dx;
      const ny = y + dy;
      if (!grid.inside(nx, ny) || grid.border(nx, ny)) continue;
      const n = grid.idx(nx, ny);
      if (dist[n] !== -1 || grid.t[n] !== T.FLOOR) continue;
      dist[n] = dist[c]! + 1;
      queue.push(n);
    }
  }
  return dist;
}

/** Plazas and streets of paving over open ground, with walled buildings whose doors face the nearest street. */
export const settlement: LayoutFn = ({ grid, setting, rooms, exits, rng, hasShallow, hints }) => {
  grid.fill(T.FLOOR);
  const shapes = arrangeRooms(grid, rooms, rng, "rect", TERRAIN.settlement.plazaScale);
  carveShapes(grid, shapes);
  shapes.forEach((s) => {
    if (!PLAZA_TYPES.has(s.type)) return;
    for (const t of s.tiles) {
      // plazas are squares with softened corners, not stamped rectangles
      const corner = (t.x === s.x0 || t.x === s.x0 + s.w - 1) && (t.y === s.y0 || t.y === s.y0 + s.h - 1);
      if (!(corner && s.w >= 5 && s.h >= 5)) grid.t[grid.idx(t.x, t.y)] = T.PATH;
    }
  });

  // water in low ground, kept off the plazas; a river through the town is crossed by its streets
  const lq = level(setting.density.liquid);
  const rd = roomDistance(grid);
  carveLakes(grid, rng, lq, (i) => grid.t[i] === T.FLOOR && rd[i]! > TERRAIN.water.roomClearance);
  carveRiver(grid, rng, lq, (i) => grid.t[i] === T.FLOOR, rd);
  if (hasShallow) addShallows(grid);

  // streets: gently winding routes, two tiles wide in bigger towns
  linkRooms(grid, shapes, rooms, TERRAIN.settlement.streetNoise);
  const target = Math.max(2, Math.floor((grid.w * grid.h) / 120) + level(setting.density.obstacles) - 1);
  let placed = 0;
  let dist = pathDistance(grid);
  for (let attempt = 0; attempt < 400 && placed < target; attempt++) {
    const small = attempt >= 120;
    const pad = attempt >= 300 && placed === 0 ? 0 : 1;
    const bw = small ? rng.int(3, 5) : rng.int(4, 7);
    const bh = small ? rng.int(3, 4) : rng.int(4, 6);
    const x = rng.int(2, grid.w - bw - 3);
    const y = rng.int(2, grid.h - bh - 4);
    if (x < 2 || y < 2) continue;
    let ok = true;
    for (let yy = y - pad; yy < y + bh + pad && ok; yy++) {
      for (let xx = x - pad; xx < x + bw + pad && ok; xx++) {
        const i = grid.idx(xx, yy);
        if (!grid.inside(xx, yy) || grid.border(xx, yy) || grid.t[i] !== T.FLOOR || grid.crit[i] || grid.room[i]! >= 0) ok = false;
      }
    }
    if (!ok) continue;
    // the door faces whichever side is closest to a street
    const sides: Array<{ door: Pt; out: Pt }> = [
      { door: { x: x + (bw >> 1), y: y + bh - 1 }, out: { x: x + (bw >> 1), y: y + bh } },
      { door: { x: x + (bw >> 1), y }, out: { x: x + (bw >> 1), y: y - 1 } },
      { door: { x, y: y + (bh >> 1) }, out: { x: x - 1, y: y + (bh >> 1) } },
      { door: { x: x + bw - 1, y: y + (bh >> 1) }, out: { x: x + bw, y: y + (bh >> 1) } },
    ];
    let best: { door: Pt; out: Pt } | undefined;
    let bestD = Infinity;
    for (const s of sides) {
      const d = dist[grid.idx(s.out.x, s.out.y)]!;
      if (d >= 0 && d < bestD) { bestD = d; best = s; }
    }
    if (!best || bestD > 9) continue;
    for (let yy = y; yy < y + bh; yy++) for (let xx = x; xx < x + bw; xx++) { grid.t[grid.idx(xx, yy)] = T.WALL; grid.block[grid.idx(xx, yy)] = placed + 1; }
    grid.t[grid.idx(best.door.x, best.door.y)] = T.DOOR;
    grid.crit[grid.idx(best.door.x, best.door.y)] = 1;
    // a short lane from the door to the street, following the distance field downhill
    let cx = best.out.x;
    let cy = best.out.y;
    for (let guard = 0; guard < 40; guard++) {
      const i = grid.idx(cx, cy);
      grid.crit[i] = 1;
      if (grid.t[i] === T.PATH) break;
      grid.t[i] = T.PATH;
      const here = dist[i]!;
      let moved = false;
      for (const [dx, dy] of DIRS4) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (grid.inside(nx, ny) && dist[grid.idx(nx, ny)] === here - 1) { cx = nx; cy = ny; moved = true; break; }
      }
      if (!moved) break;
    }
    placed++;
    dist = pathDistance(grid);
  }

  // exits and street widening come after the buildings, so they do not crowd them out
  const exitPoints: Pt[] = [];
  for (const e of exits) exitPoints.push(openExit(grid, rng, e.side, shapes, exitPoints));
  if (Math.min(grid.w, grid.h) >= 30) {
    const base = grid.t.slice();
    for (let i = 0; i < base.length; i++) {
      if (base[i] !== T.PATH) continue;
      const x = i % grid.w;
      const y = Math.floor(i / grid.w);
      const j = grid.idx(x + (grid.wander2[i]! > 0.5 ? 1 : 0), y + (grid.wander2[i]! > 0.5 ? 0 : 1));
      if (grid.inside(x + 1, y + 1) && !grid.border(j % grid.w, Math.floor(j / grid.w)) && grid.t[j] === T.FLOOR && grid.room[j]! < 0) { grid.t[j] = T.PATH; grid.crit[j] = 1; }
    }
  }
  widenPaths(grid);

  // parks and orchards in clusters, stalls and crates beside the streets, and a treeline round the edge
  growVegetation(grid, rng, { level: level(setting.density.obstacles), shapes, noRocks: true, open: new Set(shapes.map((s) => s.id)), ...(hints ? { focal: hints.focalRooms } : {}) });
  const props = TERRAIN.settlement.streetProps[level(setting.density.obstacles)]!;
  for (let i = 0; i < grid.t.length; i++) {
    if (grid.t[i] !== T.FLOOR || grid.crit[i] || grid.room[i]! >= 0 || grid.border(i % grid.w, Math.floor(i / grid.w))) continue;
    if (dist[i]! === 1 && rng.chance(props)) grid.t[i] = T.OBSTACLE;
  }
  if (setting.environment === "outdoor") growTreeline(grid, rng);
  return { shapes, exitPoints };
};
