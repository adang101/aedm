/** Shared terrain grid and helpers for the layout generators. Pure and seeded: every random choice comes from the MapRng passed in. */
import type { ExitSide, Room } from "@aedm/schemas";
import type { MapRng } from "../prng";
import type { ResolvedSetting } from "../settings";

/** Terrain codes. The assembler turns each into a material and a tile layer. */
export const T = { FLOOR: 0, PATH: 1, WALL: 2, OBSTACLE: 3, LIQUID: 4, HAZARD: 5, DOOR: 6, SHALLOW: 7, BRIDGE: 8 } as const;
export type Terrain = (typeof T)[keyof typeof T];

export const isPassable = (c: number): boolean =>
  c === T.FLOOR || c === T.PATH || c === T.HAZARD || c === T.DOOR || c === T.SHALLOW || c === T.BRIDGE;

export interface Pt {
  x: number;
  y: number;
}

export interface RoomShape {
  id: string;
  type: Room["type"];
  x0: number;
  y0: number;
  w: number;
  h: number;
  tiles: Pt[];
  center: Pt;
  /** Not in the brief (alcoves, islets): used for decoration, never for slots or points of interest. */
  extra?: boolean;
}

export class Grid {
  readonly t: Uint8Array;
  /** Index into the shape list, or -1. */
  readonly room: Int16Array;
  /** Tiles that must stay free of obstacles and hazards (corridors, paths, lines between rooms). */
  readonly crit: Uint8Array;
  /** For HAZARD tiles: which hazard material of the setting. */
  readonly haz: Uint8Array;

  constructor(readonly w: number, readonly h: number) {
    this.t = new Uint8Array(w * h);
    this.room = new Int16Array(w * h).fill(-1);
    this.crit = new Uint8Array(w * h);
    this.haz = new Uint8Array(w * h);
  }

  idx(x: number, y: number): number {
    return y * this.w + x;
  }
  inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }
  border(x: number, y: number): boolean {
    return x === 0 || y === 0 || x === this.w - 1 || y === this.h - 1;
  }
  /** Out of bounds reads as WALL. */
  get(x: number, y: number): number {
    return this.inside(x, y) ? this.t[this.idx(x, y)]! : T.WALL;
  }
  set(x: number, y: number, c: Terrain): void {
    if (this.inside(x, y)) this.t[this.idx(x, y)] = c;
  }
  passable(x: number, y: number): boolean {
    return isPassable(this.get(x, y));
  }
  fill(c: Terrain): void {
    this.t.fill(c);
  }

  /** Opens a tile for movement along a route: solid becomes PATH, liquid becomes a BRIDGE, and the tile is kept clear. */
  carve(x: number, y: number, paint = false, allowBorder = false): void {
    if (!this.inside(x, y) || (!allowBorder && this.border(x, y))) return;
    const i = this.idx(x, y);
    this.crit[i] = 1;
    const c = this.t[i]!;
    if (c === T.WALL || c === T.OBSTACLE || c === T.HAZARD) this.t[i] = T.PATH;
    else if (c === T.LIQUID) this.t[i] = T.BRIDGE;
    else if (c === T.FLOOR && paint && this.room[i]! < 0) this.t[i] = T.PATH;
  }

  /** An L-shaped route from a to b, `width` tiles wide (1 or 2). */
  route(a: Pt, b: Pt, horizontalFirst: boolean, width = 1, paint = false): void {
    const bend = horizontalFirst ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
    for (const [p, q] of [[a, bend], [bend, b]] as const) {
      const sx = Math.sign(q.x - p.x);
      const sy = Math.sign(q.y - p.y);
      let { x, y } = p;
      const step = (): void => {
        this.carve(x, y, paint);
        if (width > 1) {
          if (sy === 0) this.carve(x, y + 1, paint);
          else this.carve(x + 1, y, paint);
        }
      };
      step();
      while (x !== q.x || y !== q.y) {
        x += sx;
        y += sy;
        step();
      }
    }
  }

  /** Rasterised free-form polyline (4-connected). */
  polyline(points: readonly Pt[], width = 1, paint = false): void {
    let prev: Pt | undefined;
    for (const p of points) {
      if (prev) {
        let { x, y } = prev;
        while (x !== p.x || y !== p.y) {
          if (x !== p.x && (y === p.y || (Math.abs(p.x - x) >= Math.abs(p.y - y)))) x += Math.sign(p.x - x);
          else y += Math.sign(p.y - y);
          this.carve(x, y, paint);
          if (width > 1) this.carve(x + 1, y, paint);
        }
      } else {
        this.carve(p.x, p.y, paint);
        if (width > 1) this.carve(p.x + 1, p.y, paint);
      }
      prev = p;
    }
  }

  /** Border tiles become `code`, except tiles already opened as exits. */
  sealBorder(code: Terrain): void {
    for (let x = 0; x < this.w; x++) {
      for (const y of [0, this.h - 1]) if (this.t[this.idx(x, y)] !== T.PATH) this.t[this.idx(x, y)] = code;
    }
    for (let y = 1; y < this.h - 1; y++) {
      for (const x of [0, this.w - 1]) if (this.t[this.idx(x, y)] !== T.PATH) this.t[this.idx(x, y)] = code;
    }
  }

  /** 4-connected flood over passable tiles. */
  reachable(from: Pt, canStep: (code: number) => boolean = isPassable): Uint8Array {
    const seen = new Uint8Array(this.w * this.h);
    if (!this.inside(from.x, from.y) || !canStep(this.get(from.x, from.y))) return seen;
    const stack = [this.idx(from.x, from.y)];
    seen[stack[0]!] = 1;
    while (stack.length > 0) {
      const c = stack.pop()!;
      const x = c % this.w;
      const y = (c - x) / this.w;
      for (const [dx, dy] of DIRS4) {
        const nx = x + dx;
        const ny = y + dy;
        if (!this.inside(nx, ny)) continue;
        const n = this.idx(nx, ny);
        if (seen[n] || !canStep(this.t[n]!)) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    return seen;
  }
}

export const DIRS4: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// ---------- layout contract ----------

export interface LayoutInput {
  grid: Grid;
  setting: ResolvedSetting;
  rooms: readonly Room[];
  exits: ReadonlyArray<{ side: ExitSide; label: string }>;
  rng: MapRng;
  /** The setting has a walkable liquid (shallows) to ring ponds with. */
  hasShallow: boolean;
}

export interface LayoutOutput {
  /** One shape per brief room, in brief order, then any extras. */
  shapes: RoomShape[];
  /** For layouts that run their own exits: the border tile per brief exit, already opened. */
  exitPoints?: Array<Pt | undefined>;
  /** Add door tiles where corridors enter rooms. */
  doors?: boolean;
}

export type LayoutFn = (input: LayoutInput) => LayoutOutput;

// ---------- room shapes ----------

export type ShapeMode = "rect" | "blob";

function shapeTiles(grid: Grid, rng: MapRng, blobby: boolean, x0: number, y0: number, w: number, h: number): Pt[] {
  const tiles: Pt[] = [];
  const cx = x0 + (w - 1) / 2;
  const cy = y0 + (h - 1) / 2;
  if (!blobby) {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) tiles.push({ x, y });
    return tiles;
  }
  const cand = new Set<number>();
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const dx = (x - cx) / (w / 2);
      const dy = (y - cy) / (h / 2);
      const d = dx * dx + dy * dy;
      if (d < 0.45 || d < 0.55 + rng.next() * 0.55) cand.add(grid.idx(x, y));
    }
  }
  const seed = grid.idx(Math.round(cx), Math.round(cy));
  cand.add(seed);
  const seen = new Set<number>([seed]);
  const stack = [seed];
  while (stack.length > 0) {
    const c = stack.pop()!;
    const px = c % grid.w;
    const py = Math.floor(c / grid.w);
    for (const [dx, dy] of DIRS4) {
      const n = grid.idx(px + dx, py + dy);
      if (cand.has(n) && !seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  for (const c of [...seen].sort((a, b) => a - b)) tiles.push({ x: c % grid.w, y: Math.floor(c / grid.w) });
  return tiles;
}

export function makeShape(id: string, type: Room["type"], tiles: Pt[], cx: number, cy: number, box: { x0: number; y0: number; w: number; h: number }, extra = false): RoomShape {
  let center = tiles[0]!;
  let best = Infinity;
  for (const t of tiles) {
    const d = (t.x - cx) ** 2 + (t.y - cy) ** 2;
    if (d < best) {
      best = d;
      center = t;
    }
  }
  return { id, type, ...box, tiles, center, ...(extra ? { extra: true } : {}) };
}

/** A blob of tiles around a point, kept inside the playable interior. */
export function blobShape(grid: Grid, rng: MapRng, id: string, type: Room["type"], cx: number, cy: number, rx: number, ry: number, extra = false): RoomShape {
  const x0 = Math.max(1, Math.round(cx - rx));
  const y0 = Math.max(1, Math.round(cy - ry));
  const x1 = Math.min(grid.w - 2, Math.round(cx + rx));
  const y1 = Math.min(grid.h - 2, Math.round(cy + ry));
  const w = Math.max(1, x1 - x0 + 1);
  const h = Math.max(1, y1 - y0 + 1);
  const tiles = shapeTiles(grid, rng, true, x0, y0, w, h);
  return makeShape(id, type, tiles, x0 + (w - 1) / 2, y0 + (h - 1) / 2, { x0, y0, w, h }, extra);
}

export function rectShape(grid: Grid, id: string, type: Room["type"], x0: number, y0: number, w: number, h: number, extra = false): RoomShape {
  const xa = Math.max(1, x0);
  const ya = Math.max(1, y0);
  const xb = Math.min(grid.w - 2, x0 + w - 1);
  const yb = Math.min(grid.h - 2, y0 + h - 1);
  const ww = Math.max(1, xb - xa + 1);
  const hh = Math.max(1, yb - ya + 1);
  const tiles: Pt[] = [];
  for (let y = ya; y < ya + hh; y++) for (let x = xa; x < xa + ww; x++) tiles.push({ x, y });
  return makeShape(id, type, tiles, xa + (ww - 1) / 2, ya + (hh - 1) / 2, { x0: xa, y0: ya, w: ww, h: hh }, extra);
}

/** Places every brief room in its own cell of a serpentine grid over the map, sized by `size` and `type`. */
export function arrangeRooms(grid: Grid, rooms: readonly Room[], rng: MapRng, mode: ShapeMode): RoomShape[] {
  const n = rooms.length;
  const { w: gw, h: gh } = grid;
  const cols = Math.max(1, Math.min(n, Math.round(Math.sqrt((n * gw) / gh))));
  const rows = Math.ceil(n / cols);
  const cw = Math.floor(gw / cols);
  const ch = Math.floor(gh / rows);
  return rooms.map((room, i) => {
    const r = Math.floor(i / cols);
    const c = r % 2 === 0 ? i % cols : cols - 1 - (i % cols);
    const maxW = Math.max(2, cw - 2);
    const maxH = Math.max(2, ch - 2);
    const frac = { small: 0.5, medium: 0.7, large: 0.95 }[room.size];
    const jit = () => 0.85 + rng.next() * 0.15;
    let rw = Math.max(3, Math.round(maxW * frac * jit()));
    let rh = Math.max(3, Math.round(maxH * frac * jit()));
    const linear = room.type === "hall" || room.type === "corridor" || room.type === "street";
    if (room.type === "hall") {
      const short = { small: 3, medium: 4, large: 5 }[room.size];
      if (cw >= ch) { rw = maxW; rh = short; } else { rh = maxH; rw = short; }
    } else if (room.type === "corridor" || room.type === "street") {
      const thick = room.type === "street" ? 3 : 2;
      const long = Math.max(3, Math.round((cw >= ch ? maxW : maxH) * (0.8 + rng.next() * 0.2)));
      if (cw >= ch) { rw = long; rh = thick; } else { rh = long; rw = thick; }
    }
    rw = Math.min(rw, maxW);
    rh = Math.min(rh, maxH);
    const x0 = c * cw + 1 + rng.int(0, maxW - rw);
    const y0 = r * ch + 1 + rng.int(0, maxH - rh);
    const blobby = !linear && (mode === "blob" ? true : room.type === "cave");
    const tiles = shapeTiles(grid, rng, blobby, x0, y0, rw, rh);
    return makeShape(room.id, room.type, tiles, x0 + (rw - 1) / 2, y0 + (rh - 1) / 2, { x0, y0, w: rw, h: rh });
  });
}

export function carveShapes(grid: Grid, shapes: readonly RoomShape[], code: Terrain = T.FLOOR): void {
  shapes.forEach((s, k) => {
    for (const t of s.tiles) {
      const i = grid.idx(t.x, t.y);
      grid.t[i] = code;
      grid.room[i] = k;
    }
  });
}

/** Joins rooms along the brief's `connects_to`, then any leftover pieces, with routes between their centers. */
export function connectRooms(grid: Grid, shapes: readonly RoomShape[], rooms: readonly Room[], rng: MapRng, width = 1, paint = false): void {
  const ix = new Map(shapes.map((s, i) => [s.id, i]));
  const parent = shapes.map((_, i) => i);
  const find = (a: number): number => (parent[a] === a ? a : (parent[a] = find(parent[a]!)));
  const link = (a: number, b: number): void => {
    parent[find(a)] = find(b);
    grid.route(shapes[a]!.center, shapes[b]!.center, rng.chance(0.5), width, paint);
  };
  const done = new Set<string>();
  rooms.forEach((room, a) => {
    for (const target of room.connects_to) {
      const b = ix.get(target);
      if (b === undefined || b === a) continue;
      const k = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (done.has(k)) continue;
      done.add(k);
      link(a, b);
    }
  });
  let prev = 0;
  for (let i = 1; i < shapes.length; i++) {
    if (find(i) !== find(prev)) link(prev, i);
    prev = i;
  }
}

// ---------- scatter helpers ----------

/** Cellular-automata noise: 1 is solid. The border is always 1. */
export function caNoise(grid: Grid, rng: MapRng, p: number, iterations: number): Uint8Array {
  const { w, h } = grid;
  let m = new Uint8Array(w * h);
  for (let i = 0; i < m.length; i++) m[i] = rng.chance(p) ? 1 : 0;
  for (let it = 0; it < iterations; it++) {
    const nm = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (grid.border(x, y)) { nm[grid.idx(x, y)] = 1; continue; }
        let c = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && m[grid.idx(x + dx, y + dy)]) c++;
        nm[grid.idx(x, y)] = c >= 5 || (m[grid.idx(x, y)] && c >= 4) ? 1 : 0;
      }
    }
    m = nm;
  }
  return m;
}

/** Tiles that obstacles, ponds and hazards may take: open floor off the routes. */
export const freeFloor = (grid: Grid) => (i: number): boolean => grid.t[i] === T.FLOOR && !grid.crit[i] && !grid.border(i % grid.w, Math.floor(i / grid.w));

export function scatterObstacles(grid: Grid, rng: MapRng, rate: number, ok: (i: number) => boolean): void {
  if (rate <= 0) return;
  for (let i = 0; i < grid.t.length; i++) if (ok(i) && rng.chance(rate)) grid.t[i] = T.OBSTACLE;
}

/** A round pond; with shallows, a ring of walkable shallow water around it. */
export function pond(grid: Grid, rng: MapRng, cx: number, cy: number, r: number, shallow: boolean, ok: (i: number) => boolean): void {
  const reach = r + 2;
  for (let y = cy - reach; y <= cy + reach; y++) {
    for (let x = cx - reach; x <= cx + reach; x++) {
      if (!grid.inside(x, y) || grid.border(x, y)) continue;
      const i = grid.idx(x, y);
      if (!ok(i)) continue;
      const d = Math.hypot(x - cx, y - cy);
      if (d < r - 0.6 + rng.next() * 1.4) grid.t[i] = T.LIQUID;
      else if (shallow && d < r + 1.3 && grid.t[i] === T.FLOOR) grid.t[i] = T.SHALLOW;
    }
  }
}

/** Obstacle rate (share of free tiles) for a density level 0..3. */
export const OBSTACLE_RATE = [0, 0.012, 0.03, 0.055] as const;

export function level(n: number): 0 | 1 | 2 | 3 {
  return (n <= 0 ? 0 : n >= 3 ? 3 : Math.round(n)) as 0 | 1 | 2 | 3;
}
