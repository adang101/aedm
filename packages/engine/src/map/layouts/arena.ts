import type { MapRng } from "../prng";
import { T, blobShape, freeFloor, level, makeShape, pond, rectShape } from "./grid";
import type { Grid, LayoutFn, Pt, RoomShape } from "./grid";

function arenaShape(grid: Grid, rng: MapRng, id: string, type: RoomShape["type"], env: string, cx: number, cy: number, rw: number, rh: number): RoomShape {
  if (env === "outdoor") return blobShape(grid, rng, id, type, cx, cy, rw / 2, rh / 2);
  const base = rectShape(grid, id, type, Math.round(cx - rw / 2), Math.round(cy - rh / 2), rw, rh);
  const cut = env === "underground" ? Math.floor(Math.min(base.w, base.h) / 4) : 0;
  if (cut === 0) return base;
  // underground arenas get chamfered corners
  const tiles = base.tiles.filter((t) => {
    const ex = Math.min(t.x - base.x0, base.x0 + base.w - 1 - t.x);
    const ey = Math.min(t.y - base.y0, base.y0 + base.h - 1 - t.y);
    return ex + ey >= cut;
  });
  return makeShape(id, type, tiles, base.x0 + (base.w - 1) / 2, base.y0 + (base.h - 1) / 2, base);
}

const stamp = (grid: Grid, shape: RoomShape, index: number): void => {
  for (const t of shape.tiles) {
    const i = grid.idx(t.x, t.y);
    grid.t[i] = T.FLOOR;
    grid.room[i] = index;
  }
};

/** One large central room with a ring of pillars, pools, and small alcoves on its flanks joined by spokes. */
export const arena: LayoutFn = ({ grid, setting, rooms, rng, hasShallow }) => {
  grid.fill(T.WALL);
  const { w, h } = grid;
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const share = rooms.length > 1 ? 0.5 : 0.62;
  const rw = Math.max(7, Math.round(w * share));
  const rh = Math.max(7, Math.round(h * share));
  const first = rooms[0]!;
  const central = arenaShape(grid, rng, first.id, first.type, setting.environment, cx, cy, rw, rh);
  const shapes: RoomShape[] = [central];
  stamp(grid, central, 0);

  // alcoves for the other brief rooms, plus extras so the arena always has flanks
  const wanted = rooms.slice(1).map((r) => ({ id: r.id, type: r.type, size: r.size, extra: false }));
  for (let k = wanted.length; k < 4; k++) wanted.push({ id: `alcove_${k}`, type: "chamber" as const, size: "small" as const, extra: true });
  const start = rng.next() * Math.PI * 2;
  wanted.forEach((a, k) => {
    const dims = { small: [3, 3], medium: [4, 3], large: [5, 4] }[a.size];
    let placed: RoomShape | undefined;
    for (let attempt = 0; attempt < 30 && !placed; attempt++) {
      const ang = start + (k / wanted.length) * Math.PI * 2 + (attempt % 5) * 0.21 * (attempt % 2 === 0 ? 1 : -1);
      const shrink = attempt >= 15 ? 1 : 0;
      const aw = Math.max(2, dims[0]! - shrink);
      const ah = Math.max(2, dims[1]! - shrink);
      // walk outward from the center until the alcove clears the arena and its neighbours
      for (let r = 2; r < Math.max(w, h); r += 0.5) {
        const ax = Math.round(cx + Math.cos(ang) * r);
        const ay = Math.round(cy + Math.sin(ang) * r);
        const x0 = ax - (aw >> 1);
        const y0 = ay - (ah >> 1);
        if (x0 < 1 || y0 < 1 || x0 + aw > w - 1 || y0 + ah > h - 1) break;
        let clear = true;
        for (let y = y0 - 1; y <= y0 + ah && clear; y++) {
          for (let x = x0 - 1; x <= x0 + aw && clear; x++) if (grid.get(x, y) !== T.WALL) clear = false;
        }
        if (clear) {
          placed = rectShape(grid, a.id, a.type, x0, y0, aw, ah, a.extra);
          break;
        }
      }
    }
    if (!placed) {
      if (a.extra) return;
      throw new Error(`no room for alcove ${a.id}`);
    }
    shapes.push(placed);
    stamp(grid, placed, shapes.length - 1);
  });

  for (let k = 1; k < shapes.length; k++) grid.route(shapes[k]!.center, central.center, rng.chance(0.5), 1, false);

  const d = level(setting.density.obstacles);
  if (d > 0) {
    const n = 4 * d;
    const ring = (0.55 * Math.min(central.w, central.h)) / 2;
    const off = rng.next() * Math.PI;
    for (let k = 0; k < n; k++) {
      const ang = off + (k / n) * Math.PI * 2;
      const p: Pt = { x: Math.round(central.center.x + Math.cos(ang) * ring * (central.w / central.h)), y: Math.round(central.center.y + Math.sin(ang) * ring) };
      if (!grid.inside(p.x, p.y)) continue;
      const i = grid.idx(p.x, p.y);
      if (grid.t[i] === T.FLOOR && !grid.crit[i] && grid.room[i] === 0) grid.t[i] = T.OBSTACLE;
    }
  }
  const lq = level(setting.density.liquid);
  const pools = lq > 0 ? rng.int(1, lq) : 0;
  for (let k = 0; k < pools; k++) {
    const px = central.center.x + rng.int(-(central.w >> 2), central.w >> 2);
    const py = central.center.y + rng.int(-(central.h >> 2), central.h >> 2);
    pond(grid, rng, px, py, rng.int(1, 2), hasShallow, freeFloor(grid));
  }
  return { shapes, doors: true };
};
