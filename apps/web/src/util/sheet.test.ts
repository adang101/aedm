import { describe, expect, it } from "vitest";
import { defenseOf, growthProgress } from "./sheet";

describe("sheet helpers", () => {
  it("defense follows DEX and armor caps like the engine", () => {
    expect(defenseOf(14, 0)).toBe(12);
    expect(defenseOf(18, 2)).toBe(10 + 4 + 2);
    expect(defenseOf(18, 4)).toBe(10 + 2 + 4); // medium caps DEX at +2
    expect(defenseOf(18, 6)).toBe(10 + 0 + 6); // heavy caps at +0
  });
  it("growth progress is growth mod 100, full at the level cap", () => {
    expect(growthProgress(0, 1)).toMatchObject({ into: 0, pct: 0, maxed: false });
    expect(growthProgress(250, 3)).toMatchObject({ into: 50, need: 100, pct: 50 });
    expect(growthProgress(900, 10).maxed).toBe(true);
  });
});
