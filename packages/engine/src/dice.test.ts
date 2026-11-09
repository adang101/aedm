import { describe, expect, it } from "vitest";
import { createRng } from "./rng.ts";
import { averageHundredths, combineAdvantage, rollD20, rollDice, rollDamage, rollNotation } from "./dice.ts";

describe("dice", () => {
  it("rolls N dice within range", () => {
    const r = createRng(1);
    for (let i = 0; i < 200; i++) {
      const d = rollDice(r, 3, 6);
      expect(d).toHaveLength(3);
      for (const v of d) { expect(v).toBeGreaterThanOrEqual(1); expect(v).toBeLessThanOrEqual(6); }
    }
  });
  it("average in hundredths", () => {
    expect(averageHundredths("1d6")).toBe(350);
    expect(averageHundredths("2d4")).toBe(500);
    expect(averageHundredths("2d6")).toBe(700);
    expect(averageHundredths("3d6")).toBe(1050);
    expect(averageHundredths("1d8")).toBe(450);
  });
  it("advantage and disadvantage cancel", () => {
    expect(combineAdvantage(["advantage", "disadvantage"])).toBe("none");
    expect(combineAdvantage(["advantage", "advantage"])).toBe("advantage");
    expect(combineAdvantage(["disadvantage"])).toBe("disadvantage");
    expect(combineAdvantage(["advantage", "disadvantage", "disadvantage"])).toBe("none");
    expect(combineAdvantage([])).toBe("none");
  });
  it("d20 keeps higher / lower", () => {
    for (let s = 0; s < 50; s++) {
      const a = rollD20(createRng(s), "advantage");
      expect(a.dice).toHaveLength(2);
      expect(a.kept).toBe(Math.max(...a.dice));
      const d = rollD20(createRng(s), "disadvantage");
      expect(d.kept).toBe(Math.min(...d.dice));
      const n = rollD20(createRng(s), "none");
      expect(n.dice).toHaveLength(1);
    }
  });
  it("crit doubles the number of dice", () => {
    const r = createRng(4);
    expect(rollDamage(r, "2d6", { crit: false }).dice).toHaveLength(2);
    expect(rollDamage(r, "2d6", { crit: true }).dice).toHaveLength(4);
  });
  it("rolls notation with modifier", () => {
    const r = createRng(8);
    const x = rollNotation(r, "2d4+2");
    expect(x.dice).toHaveLength(2);
    expect(x.total).toBe(x.dice[0]! + x.dice[1]! + 2);
  });
});
