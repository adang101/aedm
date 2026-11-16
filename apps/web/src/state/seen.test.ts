import { describe, expect, it } from "vitest";
import { SeenGrid, seenFor } from "./seen";

describe("seen so far", () => {
  it("reveals a disc around a tile and clips at the map edge", () => {
    const g = new SeenGrid(20, 20);
    const n = g.reveal(0, 0, 3);
    expect(n).toBeGreaterThan(10);
    expect(g.isSeen(0, 0)).toBe(true);
    expect(g.isSeen(3, 0)).toBe(true);
    expect(g.isSeen(3, 3)).toBe(false); // the corner of the square is outside the disc
    expect(g.isSeen(10, 10)).toBe(false);
    expect(g.isSeen(-1, 0)).toBe(false);
  });

  it("bumps the version only when something new is seen", () => {
    const g = new SeenGrid(20, 20);
    g.reveal(10, 10, 2);
    const v = g.version;
    expect(g.reveal(10, 10, 2)).toBe(0);
    expect(g.version).toBe(v);
    g.reveal(12, 10, 2);
    expect(g.version).toBe(v + 1);
  });

  it("reveals again only for walkers that moved", () => {
    const g = new SeenGrid(30, 30);
    expect(g.revealFor([{ id: "a", x: 5, y: 5 }], 2)).toBeGreaterThan(0);
    expect(g.revealFor([{ id: "a", x: 5, y: 5 }], 2)).toBe(0);
    expect(g.revealFor([{ id: "a", x: 9, y: 5 }, { id: "b", x: 20, y: 20 }], 2)).toBeGreaterThan(0);
    expect(g.isSeen(20, 20)).toBe(true);
    expect(g.fraction()).toBeGreaterThan(0);
  });

  it("keeps a grid per room and map for the session", () => {
    const a = seenFor("r1", "m1", 7, 20, 20);
    a.reveal(1, 1, 2);
    expect(seenFor("r1", "m1", 7, 20, 20)).toBe(a);
    expect(seenFor("r2", "m1", 7, 20, 20)).not.toBe(a);
    expect(seenFor("r1", "m1", 8, 20, 20)).not.toBe(a);
  });
});
