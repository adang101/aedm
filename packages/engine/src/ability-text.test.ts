import { describe, expect, it } from "vitest";
import { fixtures } from "@aedm/schemas";
import { abilityCostGuide, abilitySummary } from "./ability-text.ts";
import { COSTS } from "./data.ts";

describe("abilityCostGuide", () => {
  const guide = abilityCostGuide();
  it("renders a short guide with no holes", () => {
    expect(guide.split(/\s+/).length).toBeLessThan(150);
    expect(guide).not.toMatch(/NaN|undefined|null|\[object/);
    for (const word of ["damage", "area", "range", "duration", "cooldown"]) expect(guide.toLowerCase()).toContain(word);
  });
  it("is generated from the data it is given", () => {
    const pricier = { ...COSTS, area: { ...COSTS.area, burst1: 175 }, damagePriceDivisor: 3 };
    expect(abilityCostGuide(pricier)).not.toBe(guide);
    expect(abilityCostGuide(pricier)).toContain("1.75");
  });
});

describe("abilitySummary", () => {
  it("is one short line per ability", () => {
    for (const { ability } of fixtures.ABILITY_FIXTURES) {
      const s = abilitySummary(ability);
      expect(s).not.toMatch(/NaN|undefined|\n/);
      expect(s.length).toBeGreaterThan(5);
      expect(s.length).toBeLessThanOrEqual(160);
    }
  });
  it("names dice, damage type, area and range", () => {
    const burst = fixtures.ABILITY_FIXTURES.map((f) => f.ability).find((a) => a.effects.some((e) => e.type === "damage" && e.shape === "burst"));
    expect(burst).toBeDefined();
    expect(abilitySummary(burst!)).toMatch(/\d+d\d+ \w+ damage burst r\d/);
    expect(abilitySummary(burst!)).toMatch(/range \d+/);
  });
});
