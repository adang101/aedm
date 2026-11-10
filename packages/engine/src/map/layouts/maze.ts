import type { Room } from "@aedm/schemas";
import { T, makeShape, level, OBSTACLE_RATE, scatterObstacles } from "./grid";
import type { LayoutFn, RoomShape } from "./grid";

const PITCH = 3;
const CELLS: Record<Room["size"], [number, number]> = { small: [2, 2], medium: [2, 3], large: [3, 3] };

/** Recursive-backtracker maze on a coarse grid (2-wide corridors, 1-wide walls) with the brief's rooms carved in. */
export const maze: LayoutFn = ({ grid, setting, rooms, rng }) => {
  const { w, h } = grid;
  grid.fill(T.WALL);
  const cw = Math.floor((w - 4) / PITCH) + 1;
  const ch = Math.floor((h - 4) / PITCH) + 1;
  const owner = new Int16Array(cw * ch).fill(-1);
  const tile = (c: number) => 1 + PITCH * c;

  // rooms occupy blocks of cells, shrinking when the map is crowded
  const blocks: Array<{ c0: number; r0: number; bw: number; bh: number }> = [];
  rooms.forEach((room, k) => {
    const [a, b] = CELLS[room.size];
    const options: Array<[number, number]> = rng.chance(0.5) ? [[a, b], [b, a]] : [[b, a], [a, b]];
    options.push([2, 2], [1, 1]);
    for (const [bw, bh] of options) {
      if (bw > cw || bh > ch) continue;
      for (let attempt = 0; attempt < 60; attempt++) {
        const c0 = rng.int(0, cw - bw);
        const r0 = rng.int(0, ch - bh);
        let free = true;
        for (let r = r0; r < r0 + bh && free; r++) for (let c = c0; c < c0 + bw && free; c++) if (owner[r * cw + c]! >= 0) free = false;
        if (!free) continue;
        for (let r = r0; r < r0 + bh; r++) for (let c = c0; c < c0 + bw; c++) owner[r * cw + c] = k;
        blocks[k] = { c0, r0, bw, bh };
        return;
      }
    }
    throw new Error(`no maze cell for room ${room.id}`);
  });

  const open = new Set<number>();
  const openCell = (c: number, r: number): void => {
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) grid.t[grid.idx(tile(c) + dx, tile(r) + dy)] = T.FLOOR;
  };
  const link = (c1: number, r1: number, c2: number, r2: number): void => {
    const x = tile(Math.min(c1, c2)) + (c1 !== c2 ? 2 : 0);
    const y = tile(Math.min(r1, r2)) + (r1 !== r2 ? 2 : 0);
    for (let dy = 0; dy < (r1 !== r2 ? 1 : 2); dy++) {
      for (let dx = 0; dx < (c1 !== c2 ? 1 : 2); dx++) {
        grid.t[grid.idx(x + dx, y + dy)] = T.FLOOR;
        grid.crit[grid.idx(x + dx, y + dy)] = 1;
      }
    }
    open.add(Math.min(r1 * cw + c1, r2 * cw + c2) * 2 + (c1 !== c2 ? 0 : 1));
  };

  for (let r = 0; r < ch; r++) for (let c = 0; c < cw; c++) openCell(c, r);
  // spanning tree (iterative backtracker)
  const seen = new Uint8Array(cw * ch);
  const stack: number[] = [rng.int(0, cw * ch - 1)];
  seen[stack[0]!] = 1;
  while (stack.length > 0) {
    const cur = stack[stack.length - 1]!;
    const c = cur % cw;
    const r = (cur - c) / cw;
    const next: Array<[number, number]> = [];
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc >= 0 && nr >= 0 && nc < cw && nr < ch && !seen[nr * cw + nc]) next.push([nc, nr]);
    }
    if (next.length === 0) { stack.pop(); continue; }
    const [nc, nr] = rng.pick(next);
    seen[nr * cw + nc] = 1;
    link(c, r, nc, nr);
    stack.push(nr * cw + nc);
  }
  // braiding: a few extra openings so the maze has loops
  const braid = 0.04 + 0.05 * level(setting.density.obstacles);
  for (let r = 0; r < ch; r++) {
    for (let c = 0; c < cw; c++) {
      if (c + 1 < cw && !open.has((r * cw + c) * 2) && rng.chance(braid)) link(c, r, c + 1, r);
      if (r + 1 < ch && !open.has((r * cw + c) * 2 + 1) && rng.chance(braid)) link(c, r, c, r + 1);
    }
  }

  // rooms: open the whole block, walls between its cells included
  const shapes: RoomShape[] = rooms.map((room, k) => {
    const b = blocks[k]!;
    const x0 = tile(b.c0);
    const y0 = tile(b.r0);
    const rw = tile(b.c0 + b.bw - 1) + 2 - x0;
    const rh = tile(b.r0 + b.bh - 1) + 2 - y0;
    const tiles = [];
    for (let y = y0; y < y0 + rh; y++) {
      for (let x = x0; x < x0 + rw; x++) {
        const i = grid.idx(x, y);
        grid.t[i] = T.FLOOR;
        grid.room[i] = k;
        grid.crit[i] = 0;
        tiles.push({ x, y });
      }
    }
    return makeShape(room.id, room.type, tiles, x0 + (rw - 1) / 2, y0 + (rh - 1) / 2, { x0, y0, w: rw, h: rh });
  });
  // corridors that touch a room stay clear for the way in
  const inRoom = (i: number) => grid.t[i] === T.FLOOR && grid.room[i]! >= 0 && !grid.crit[i];
  scatterObstacles(grid, rng, OBSTACLE_RATE[level(setting.density.obstacles)], inRoom);
  // every corridor tile is part of the only way through
  for (let i = 0; i < grid.t.length; i++) if (grid.t[i] === T.FLOOR && grid.room[i]! < 0) grid.crit[i] = 1;
  return { shapes };
};
