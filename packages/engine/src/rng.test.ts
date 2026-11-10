import { describe, expect, it } from "vitest";
import { createRng, fromState } from "./rng.ts";

describe("rng", () => {
  it("is deterministic for a seed (exact sequence)", () => {
    const r = createRng(12345);
    const seq = Array.from({ length: 5 }, () => r.int(1, 20));
    const r2 = createRng(12345);
    expect(Array.from({ length: 5 }, () => r2.int(1, 20))).toEqual(seq);
    expect(seq).toEqual(EXPECTED_SEQ);
  });
  it("differs across seeds", () => {
    expect(createRng(1).next()).not.toBe(createRng(2).next());
  });
  it("next() is in [0,1)", () => {
    const r = createRng(7);
    for (let i = 0; i < 1000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
  it("int is inclusive on both ends", () => {
    const r = createRng(99);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) seen.add(r.int(1, 4));
    expect([...seen].sort()).toEqual([1, 2, 3, 4]);
  });
  it("state round trips", () => {
    const r = createRng(5);
    r.next(); r.next();
    const s = r.state();
    const a = [r.next(), r.next()];
    const r2 = fromState(s);
    expect([r2.next(), r2.next()]).toEqual(a);
  });
  it("pick returns an element and rejects empty arrays", () => {
    const r = createRng(3);
    expect(["a", "b", "c"]).toContain(r.pick(["a", "b", "c"]));
    expect(() => r.pick([])).toThrow();
  });
});

const EXPECTED_SEQ: number[] = [4, 1, 8, 14, 12];
