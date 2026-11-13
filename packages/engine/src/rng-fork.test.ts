import { describe, expect, it } from "vitest";
import { createRng, forkRng, hashSeed } from "./rng.ts";

describe("hashSeed", () => {
  it("is a stable unsigned 32-bit hash of its parts", () => {
    expect(hashSeed(1, "chest_1")).toBe(hashSeed(1, "chest_1"));
    expect(hashSeed(1, "chest_1")).not.toBe(hashSeed(1, "chest_2"));
    expect(hashSeed(1, "chest_1")).not.toBe(hashSeed(2, "chest_1"));
    expect(hashSeed("a", "bc")).not.toBe(hashSeed("ab", "c"));
    const h = hashSeed(42, "x", 7);
    expect(Number.isInteger(h) && h >= 0 && h < 2 ** 32).toBe(true);
  });
});

describe("forkRng", () => {
  it("does not advance the stream it forks from", () => {
    const a = createRng(9);
    const b = createRng(9);
    const f = forkRng(a, "drop");
    f.next(); f.next();
    expect(a.state()).toBe(b.state());
    expect(a.next()).toBe(b.next());
  });
  it("is deterministic for a stream position and salt, and differs by salt", () => {
    const seq = (salt: string) => { const f = forkRng(createRng(5), salt); return [f.int(1, 1000), f.int(1, 1000), f.int(1, 1000)]; };
    expect(seq("a")).toEqual(seq("a"));
    expect(seq("a")).not.toEqual(seq("b"));
  });
});
