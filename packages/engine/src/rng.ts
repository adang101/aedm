/** Seeded, serializable PRNG (mulberry32). The only source of randomness in the engine. */

export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  pick<T>(arr: readonly T[]): T;
  /** Serializable state; feed to `fromState` to resume the exact sequence. */
  state(): number;
}

export function fromState(initial: number): Rng {
  let a = initial >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(min, max) {
      if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) throw new Error(`rng.int: bad range ${min}..${max}`);
      return min + Math.floor(next() * (max - min + 1));
    },
    pick(arr) {
      if (arr.length === 0) throw new Error("rng.pick: empty array");
      return arr[Math.floor(next() * arr.length)] as (typeof arr)[number];
    },
    state: () => a,
  };
}

/** Mix an arbitrary integer seed into a well-spread initial state. */
export function createRng(seed: number): Rng {
  let s = (seed | 0) ^ 0x9e3779b9;
  s = Math.imul(s ^ (s >>> 16), 0x85ebca6b);
  s = Math.imul(s ^ (s >>> 13), 0xc2b2ae35);
  s ^= s >>> 16;
  return fromState(s >>> 0);
}
