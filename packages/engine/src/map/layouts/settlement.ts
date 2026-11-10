import { DIRS4, OBSTACLE_RATE, T, arrangeRooms, carveShapes, connectRooms, level, pond, scatterObstacles } from "./grid";
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
export const settlement: LayoutFn = ({ grid, setting, rooms, rng, hasShallow }) => {
  grid.fill(T.FLOOR);
  const lq = level(setting.density.liquid);
  const ponds = lq === 0 ? 0 : rng.int(1, lq);
  for (let k = 0; k < ponds; k++) {
    pond(grid, rng, rng.int(4, grid.w - 5), rng.int(4, grid.h - 5), rng.int(2, 2 + lq), hasShallow, (i) => grid.t[i] === T.FLOOR);
  }

  const shapes = arrangeRooms(grid, rooms, rng, "rect");
  carveShapes(grid, shapes);
  shapes.forEach((s) => {
    if (!PLAZA_TYPES.has(s.type)) return;
    for (const t of s.tiles) grid.t[grid.idx(t.x, t.y)] = T.PATH;
  });
  connectRooms(grid, shapes, rooms, rng, Math.min(grid.w, grid.h) >= 30 ? 2 : 1, true);

  const target = Math.max(2, Math.floor((grid.w * grid.h) / 120) + level(setting.density.obstacles) - 1);
  let placed = 0;
  let dist = pathDistance(grid);
  for (let attempt = 0; attempt < 200 && placed < target; attempt++) {
    const bw = rng.int(4, 7);
    const bh = rng.int(4, 6);
    const x = rng.int(2, grid.w - bw - 3);
    const y = rng.int(2, grid.h - bh - 4);
    if (x < 2 || y < 2) continue;
    let ok = true;
    for (let yy = y - 1; yy <= y + bh && ok; yy++) {
      for (let xx = x - 1; xx <= x + bw && ok; xx++) {
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
    for (let yy = y; yy < y + bh; yy++) for (let xx = x; xx < x + bw; xx++) grid.t[grid.idx(xx, yy)] = T.WALL;
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

  const free = (i: number) => grid.t[i] === T.FLOOR && !grid.crit[i] && grid.room[i]! < 0 && !grid.border(i % grid.w, Math.floor(i / grid.w));
  scatterObstacles(grid, rng, OBSTACLE_RATE[level(setting.density.obstacles)] * 1.3, free);
  return { shapes };
};
