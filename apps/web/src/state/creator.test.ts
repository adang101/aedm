import { describe, expect, it } from "vitest";
import { autoGlyph, buildCreate, emptyForm, premadeForms, toggleTrait } from "./creator";
import { blank, paintCells, rectCells, toRecipe } from "./pixel-editor";
import { adjust, baseScores, canIncrease, pointsLeft, pointsSpent, scoreCost } from "./pointbuy";

describe("point buy", () => {
  it("costs match the rules table", () => {
    expect([8, 9, 10, 11, 12, 13, 14, 15].map(scoreCost)).toEqual([0, 1, 2, 3, 4, 5, 7, 9]);
  });

  it("starts with the full budget and counts spending", () => {
    const s = baseScores();
    expect(pointsLeft(s)).toBe(27);
    const s2 = adjust(adjust(s, "str", 1), "str", 1);
    expect(s2.str).toBe(10);
    expect(pointsSpent(s2)).toBe(2);
    expect(pointsLeft(s2)).toBe(25);
  });

  it("refuses to exceed 15, drop below 8 or overspend", () => {
    let s = baseScores();
    for (let i = 0; i < 10; i++) s = adjust(s, "int", 1);
    expect(s.int).toBe(15);
    expect(adjust(s, "int", 1)).toBe(s);
    expect(adjust(baseScores(), "dex", -1).dex).toBe(8);
    // 15 (9) + 15 (9) + 15 (9) = 27, nothing left for a fourth
    let t = baseScores();
    for (const k of ["str", "dex", "con"] as const) for (let i = 0; i < 7; i++) t = adjust(t, k, 1);
    expect(pointsLeft(t)).toBe(0);
    expect(canIncrease(t, "int")).toBe(false);
  });

  it("every premade spends exactly 27 points and validates", () => {
    for (const p of premadeForms()) {
      expect(pointsLeft(p.form.scores)).toBe(0);
      const r = buildCreate(p.form);
      expect(r.ok, p.label).toBe(true);
      if (r.ok) expect(r.value.ability_texts?.length).toBe(3);
    }
  });
});

describe("creator form", () => {
  it("auto glyph follows the first letter", () => {
    expect(autoGlyph("  brindle")).toBe("B");
    expect(autoGlyph("")).toBe("?");
    expect(autoGlyph("!!")).toBe("?");
  });

  it("allows at most two traits", () => {
    let t = toggleTrait([], "stealth");
    t = toggleTrait(t, "speed");
    expect(toggleTrait(t, "lore")).toEqual(["stealth", "speed"]);
    expect(toggleTrait(t, "speed")).toEqual(["stealth"]);
  });

  it("reports inline errors for an empty form", () => {
    const r = buildCreate(emptyForm());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.name).toBeTruthy();
      expect(r.errors.scores).toMatch(/27/);
      expect(r.errors.traits).toBeTruthy();
      expect(r.errors.abilities).toBeTruthy();
    }
  });

  const goodForm = () => {
    const f = premadeForms()[0]!.form;
    return f;
  };
  const painted = (rect: [number, number, number, number]) => {
    let px = blank();
    px = paintCells(px, rectCells(...rect, true), 6);
    return toRecipe(px, { size: "medium" });
  };

  it("uses a painted sprite as the recipe", () => {
    const form = { ...goodForm(), painted: painted([16, 10, 31, 60]) };
    const r = buildCreate(form);
    expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
    if (r.ok) expect(r.value.sprite_recipe?.kind).toBe("pixel");
  });

  it("refuses a painted sprite that breaks the rules", () => {
    const r = buildCreate({ ...goodForm(), painted: painted([0, 10, 31, 60]) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.sprite).toMatch(/empty space/);
  });
});
