import type { GameMap, MapObject } from "@aedm/schemas";

export interface Point {
  x: number;
  y: number;
}

export const key = (x: number, y: number): string => `${x},${y}`;

function layerData(map: GameMap, name: "ground" | "walls" | "decor" | "above"): number[] {
  for (const l of map.layers) if (l.type === "tilelayer" && l.name === name) return l.data;
  return [];
}
export const groundOf = (m: GameMap) => layerData(m, "ground");
export const wallsOf = (m: GameMap) => layerData(m, "walls");

export function getObjects(map: GameMap): MapObject[] {
  for (const l of map.layers) if (l.type === "objectgroup") return l.objects;
  return [];
}

export function getSpawn(map: GameMap, name: string): Point | null {
  for (const o of getObjects(map)) if (o.type === "spawn" && o.name === name) return { x: o.x, y: o.y };
  return null;
}

export function inBounds(map: GameMap, x: number, y: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < map.width && y < map.height;
}

/** In bounds and the walls layer is 0. */
export function isWalkable(map: GameMap, x: number, y: number): boolean {
  if (!inBounds(map, x, y)) return false;
  return (wallsOf(map)[y * map.width + x] ?? 0) === 0;
}

/** Chebyshev distance in tiles. */
export function distance(a: Point, b: Point): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** Bresenham line of sight. Walls and blocker tiles between the endpoints block; endpoints never do. */
export function hasLineOfSight(map: GameMap, a: Point, b: Point, blockers?: Set<string>): boolean {
  let x = a.x;
  let y = a.y;
  const dx = Math.abs(b.x - a.x);
  const dy = Math.abs(b.y - a.y);
  const sx = a.x < b.x ? 1 : -1;
  const sy = a.y < b.y ? 1 : -1;
  let err = dx - dy;
  while (x !== b.x || y !== b.y) {
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
    if (x === b.x && y === b.y) break;
    if (!isWalkable(map, x, y) || blockers?.has(key(x, y))) return false;
  }
  return true;
}

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [1, 1], [-1, 1], [-1, -1],
];

/** A* over 8 directions, uniform cost, no corner cutting through walls. Excludes start, includes goal. */
export function findPath(map: GameMap, from: Point, to: Point, occupied?: Set<string>): Point[] | null {
  if (!isWalkable(map, to.x, to.y) || occupied?.has(key(to.x, to.y))) return null;
  if (!inBounds(map, from.x, from.y)) return null;
  if (from.x === to.x && from.y === to.y) return [];
  const w = map.width;
  const start = from.y * w + from.x;
  const goal = to.y * w + to.x;
  const g = new Map<number, number>([[start, 0]]);
  const prev = new Map<number, number>();
  const closed = new Set<number>();
  // Binary heap of [f, h, order, node]; order makes ties deterministic.
  const heap: number[][] = [];
  const less = (p: number[], q: number[]) =>
    p[0]! < q[0]! || (p[0] === q[0] && (p[1]! < q[1]! || (p[1] === q[1] && p[2]! < q[2]!)));
  const push = (n: number[]) => {
    heap.push(n);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const pop = (): number[] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l]!, heap[m]!)) m = l;
        if (r < heap.length && less(heap[r]!, heap[m]!)) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m]!, heap[i]!];
        i = m;
      }
    }
    return top;
  };
  const h = (n: number) => Math.max(Math.abs((n % w) - to.x), Math.abs(Math.floor(n / w) - to.y));
  let order = 0;
  push([h(start), h(start), order++, start]);
  while (heap.length > 0) {
    const cur = pop()[3]!;
    if (cur === goal) {
      const path: Point[] = [];
      let n = goal;
      while (n !== start) {
        path.push({ x: n % w, y: Math.floor(n / w) });
        n = prev.get(n)!;
      }
      return path.reverse();
    }
    if (closed.has(cur)) continue;
    closed.add(cur);
    const cx = cur % w;
    const cy = Math.floor(cur / w);
    const gc = g.get(cur)!;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!isWalkable(map, nx, ny) || occupied?.has(key(nx, ny))) continue;
      if (dx !== 0 && dy !== 0 && (!isWalkable(map, cx + dx, cy) || !isWalkable(map, cx, cy + dy))) continue;
      const n = ny * w + nx;
      if (closed.has(n)) continue;
      const ng = gc + 1;
      if (ng < (g.get(n) ?? Infinity)) {
        g.set(n, ng);
        prev.set(n, cur);
        push([ng + h(n), h(n), order++, n]);
      }
    }
  }
  return null;
}

/** Nearest (BFS, 8-dir over walkable tiles) walkable tile that is not occupied. May return the origin itself. */
export function findFreeTileNear(map: GameMap, x: number, y: number, occupied: Set<string>): Point | null {
  if (!inBounds(map, x, y)) return null;
  const seen = new Set<number>([y * map.width + x]);
  let queue: Point[] = [{ x, y }];
  while (queue.length > 0) {
    const next: Point[] = [];
    for (const p of queue) {
      if (isWalkable(map, p.x, p.y) && !occupied.has(key(p.x, p.y))) return p;
      for (const [dx, dy] of DIRS) {
        const nx = p.x + dx;
        const ny = p.y + dy;
        if (!isWalkable(map, nx, ny)) continue;
        const id = ny * map.width + nx;
        if (seen.has(id)) continue;
        seen.add(id);
        next.push({ x: nx, y: ny });
      }
    }
    queue = next;
  }
  return null;
}

const encoder = new TextEncoder();

/** UTF-8 byte length of JSON.stringify(map). */
export function serializeSize(map: GameMap): number {
  return encoder.encode(JSON.stringify(map)).length;
}
