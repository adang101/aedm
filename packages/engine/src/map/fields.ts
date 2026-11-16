/** Smooth seeded noise fields, quantiles and a small route search, shared by the natural-terrain generators. Pure: no Date, no Math.random. */
import data from "../../data/terrain.json";

export const TERRAIN = data;

/** Integer lattice hash to [0, 1). Independent of call order, so a field never depends on what else was generated. */
export function lattice(seed: number, x: number, y: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(x + 0x7f4a7c15, 0xc2b2ae35) ^ Math.imul(y + 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** One octave of smooth value noise in [0, 1). */
export function valueNoise(seed: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = lattice(seed, x0, y0);
  const b = lattice(seed, x0 + 1, y0);
  const c = lattice(seed, x0, y0 + 1);
  const d = lattice(seed, x0 + 1, y0 + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

export interface FieldSpec {
  scale: number;
  octaves: number;
  gain: number;
}

/** Fractal noise: a few octaves of value noise, each twice as fine and `gain` times as strong. About [0, 1]. */
export function fbm(seed: number, x: number, y: number, spec: FieldSpec): number {
  let amp = 1;
  let sum = 0;
  let norm = 0;
  let f = 1 / spec.scale;
  for (let o = 0; o < spec.octaves; o++) {
    sum += amp * valueNoise(seed + o * 1013, x * f, y * f);
    norm += amp;
    amp *= spec.gain;
    f *= 2;
  }
  return sum / norm;
}

/** A w x h field of fbm values, stretched to span exactly [0, 1] so thresholds and quantiles behave the same on every seed. */
export function makeField(w: number, h: number, seed: number, spec: FieldSpec): Float32Array {
  const v = new Float32Array(w * h);
  let lo = Infinity;
  let hi = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const n = fbm(seed, x, y, spec);
      v[y * w + x] = n;
      if (n < lo) lo = n;
      if (n > hi) hi = n;
    }
  }
  const span = hi - lo || 1;
  for (let i = 0; i < v.length; i++) v[i] = (v[i]! - lo) / span;
  return v;
}

/** The value below which a share `q` (0..1) of the values selected by `ok` lie. Returns 2 (above everything) when nothing is selected. */
export function quantile(values: ArrayLike<number>, q: number, ok: (i: number) => boolean): number {
  const picked: number[] = [];
  for (let i = 0; i < values.length; i++) if (ok(i)) picked.push(values[i]!);
  if (picked.length === 0) return 2;
  picked.sort((a, b) => a - b);
  return picked[Math.min(picked.length - 1, Math.max(0, Math.floor(q * picked.length)))]!;
}

export const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1)));
  return t * t * (3 - 2 * t);
};

/** Binary min-heap of (priority, item), for route search. Ties break by insertion order, so results are deterministic. */
export class MinHeap {
  private readonly p: number[] = [];
  private readonly v: number[] = [];
  private readonly n: number[] = [];
  private count = 0;

  get size(): number {
    return this.p.length;
  }

  private less(a: number, b: number): boolean {
    return this.p[a]! < this.p[b]! || (this.p[a] === this.p[b] && this.n[a]! < this.n[b]!);
  }

  private swap(a: number, b: number): void {
    [this.p[a], this.p[b]] = [this.p[b]!, this.p[a]!];
    [this.v[a], this.v[b]] = [this.v[b]!, this.v[a]!];
    [this.n[a], this.n[b]] = [this.n[b]!, this.n[a]!];
  }

  push(priority: number, item: number): void {
    this.p.push(priority);
    this.v.push(item);
    this.n.push(this.count++);
    let i = this.p.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.v[0]!;
    const last = this.p.length - 1;
    this.swap(0, last);
    this.p.pop();
    this.v.pop();
    this.n.pop();
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < this.p.length && this.less(l, m)) m = l;
      if (r < this.p.length && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
    return top;
  }
}

/** Must stay below the cheapest tile cost (paths.pathCost) so the search stays consistent. */
const HEURISTIC = 0.3;

/**
 * Cheapest 4-connected route from `from` to `to` (cell indices) over a w x h grid. `cost(i)` is the price of stepping onto
 * cell i (Infinity forbids it). Returns the cells from start to goal, or an empty list when unreachable.
 */
export function findRoute(w: number, h: number, from: number, to: number, cost: (i: number) => number): number[] {
  const best = new Float64Array(w * h).fill(Infinity);
  const prev = new Int32Array(w * h).fill(-1);
  const tx = to % w;
  const ty = (to - tx) / w;
  const heap = new MinHeap();
  best[from] = 0;
  heap.push(0, from);
  let budget = w * h * 12;
  while (heap.size > 0) {
    if (--budget < 0) throw new Error("route search ran past its budget");
    const c = heap.pop();
    if (c === to) break;
    const x = c % w;
    const y = (c - x) / w;
    const g = best[c]!;
    for (let k = 0; k < 4; k++) {
      const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0);
      const ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      const step = n === to ? 0 : cost(n);
      if (step === Infinity) continue;
      const ng = g + step;
      if (ng < best[n]!) {
        best[n] = ng;
        prev[n] = c;
        // a mild heuristic, below the cheapest step, keeps the search focused, exact and without re-expansion
        heap.push(ng + HEURISTIC * (Math.abs(nx - tx) + Math.abs(ny - ty)), n);
      }
    }
  }
  if (from !== to && prev[to] === -1) return [];
  const out: number[] = [];
  for (let c = to; c !== -1; c = prev[c]!) out.push(c);
  return out.reverse();
}
