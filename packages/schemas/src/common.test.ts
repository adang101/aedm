import { describe, expect, it } from "vitest";
import { DiceSchema, maxWords, parseDice, text, wordRange } from "./common";

describe("common", () => {
  it("trims strings and enforces max", () => {
    expect(text(5).parse("  hi  ")).toBe("hi");
    expect(text(5).safeParse("toolong").success).toBe(false);
    expect(text(5).safeParse("   ").success).toBe(false);
    expect(text(5, 0).parse("  ")).toBe("");
  });
  it("word counting", () => {
    expect(wordRange(2, 3).safeParse("one").success).toBe(false);
    expect(wordRange(2, 3).safeParse("one two").success).toBe(true);
    expect(wordRange(2, 3).safeParse("a b c d").success).toBe(false);
    expect(maxWords(2).safeParse("").success).toBe(true);
    expect(maxWords(2).safeParse("a b c").success).toBe(false);
  });
  it("dice validation and parsing", () => {
    for (const ok of ["1d4", "2d6", "8d12", "3d10", "1d8"]) expect(DiceSchema.safeParse(ok).success).toBe(true);
    for (const bad of ["0d6", "9d6", "2d7", "d6", "2d20", "2D6", "2d6+1", "2 d6"]) expect(DiceSchema.safeParse(bad).success).toBe(false);
    expect(parseDice("2d6")).toEqual({ count: 2, sides: 6 });
    expect(() => parseDice("2d7")).toThrow();
  });
});
