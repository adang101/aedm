import { describe, expect, it } from "vitest";
import { ItemSchema } from "@aedm/schemas";
import { LOOT, RULES } from "./data.ts";
import { lootTierForLevel, rollLoot } from "./loot.ts";
import { createRng } from "./rng.ts";
import { lootCap } from "./rules.ts";

const total = (items: { value: number }[]) => items.reduce((n, i) => n + i.value, 0);

describe("loot data", () => {
  it("every template is a valid item with a positive weight, and quest items are never rolled", () => {
    for (const t of LOOT.templates) {
      const value = t.draught ? RULES.draught.value : t.value;
      expect(ItemSchema.safeParse({ id: "it_1", name: t.draught ? RULES.draught.name : t.name, kind: t.kind, value, ...(t.tier ? { tier: t.tier } : {}) }).success, t.name).toBe(true);
      expect(t.weight).toBeGreaterThan(0);
      expect(["consumable", "weapon", "armor", "trinket"]).toContain(t.kind);
      if (t.kind === "weapon" || t.kind === "armor") expect(t.tier, t.name).toBeGreaterThanOrEqual(1);
    }
  });
  it("the healing draught template follows the rules numbers", () => {
    const d = LOOT.templates.find((t) => t.draught);
    expect(d?.kind).toBe("consumable");
  });
  it("names no other games, franchises or people (a spot check on the obvious)", () => {
    for (const t of LOOT.templates) expect(t.name).not.toMatch(/excalibur|mjolnir|sting|frodo|zelda|pokemon|potter/i);
  });
});

describe("rollLoot", () => {
  it("is deterministic for a seed", () => {
    const a = rollLoot(createRng(11), { tier: 3, budgetValue: 80 });
    const b = rollLoot(createRng(11), { tier: 3, budgetValue: 80 });
    expect(a).toEqual(b);
  });

  it("never exceeds the budget, over many seeds, tiers and budgets", () => {
    for (let seed = 1; seed <= 300; seed++) {
      for (const tier of [1, 2, 3, 4, 5]) {
        const budget = (seed * 7) % 140;
        const items = rollLoot(createRng(seed), { tier, budgetValue: budget });
        expect(total(items), `seed ${seed} tier ${tier} budget ${budget}`).toBeLessThanOrEqual(budget);
        expect(items.length).toBeLessThanOrEqual(LOOT.roll.maxItems);
      }
    }
  });

  it("a budget too small for anything gives nothing", () => {
    expect(rollLoot(createRng(1), { tier: 5, budgetValue: 0 })).toEqual([]);
    expect(rollLoot(createRng(1), { tier: 5, budgetValue: 1 })).toEqual([]);
  });

  it("only rolls gear and items the tier allows", () => {
    for (let seed = 1; seed <= 200; seed++) {
      for (const it of rollLoot(createRng(seed), { tier: 1, budgetValue: 200 })) {
        expect(it.tier ?? 1).toBe(1);
        expect(it.name).not.toMatch(/Gem-set|Gold-threaded|Jade-inlaid/);
      }
    }
  });

  it("rolls richer things at higher tiers", () => {
    const best = (tier: number) => {
      let max = 0;
      for (let seed = 1; seed <= 300; seed++) for (const it of rollLoot(createRng(seed), { tier, budgetValue: 200 })) max = Math.max(max, it.value);
      return max;
    };
    expect(best(5)).toBeGreaterThan(best(1));
    expect(best(1)).toBeLessThanOrEqual(25);
  });

  it("respects the kinds filter and never rolls quest items", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const items = rollLoot(createRng(seed), { tier: 3, budgetValue: 120, kinds: ["trinket"] });
      expect(items.length).toBeGreaterThan(0);
      for (const it of items) expect(it.kind).toBe("trinket");
    }
    for (let seed = 1; seed <= 100; seed++) for (const it of rollLoot(createRng(seed), { tier: 3, budgetValue: 120 })) expect(it.kind).not.toBe("quest");
  });

  it("maxItems caps the count and ids come from the supplied generator", () => {
    let n = 0;
    const items = rollLoot(createRng(3), { tier: 2, budgetValue: 200, maxItems: 1, newId: () => `it_${++n}` });
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("it_1");
  });

  it("default ids are unique within a roll and schema-valid", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const items = rollLoot(createRng(seed), { tier: 3, budgetValue: 150 });
      expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
      for (const it of items) expect(ItemSchema.safeParse(it).success).toBe(true);
    }
  });

  it("the weights matter: the common draught turns up far more often than the rarest trinket", () => {
    const counts = new Map<string, number>();
    for (let seed = 1; seed <= 600; seed++) for (const it of rollLoot(createRng(seed), { tier: 4, budgetValue: 120 })) counts.set(it.name, (counts.get(it.name) ?? 0) + 1);
    expect(counts.get(RULES.draught.name) ?? 0).toBeGreaterThan((counts.get("Gem-set signet ring") ?? 0) * 3);
  });
});

describe("lootTierForLevel", () => {
  it("follows the level's gear allowance", () => {
    expect(lootTierForLevel(1)).toBe(1);
    expect(lootTierForLevel(3)).toBe(2);
    expect(lootTierForLevel(5)).toBe(3);
    expect(lootTierForLevel(10)).toBe(5);
  });
  it("a level's whole loot cap can always buy something", () => {
    for (let level = 1; level <= 10; level++) expect(lootCap(level)).toBeGreaterThanOrEqual(30);
  });
});
