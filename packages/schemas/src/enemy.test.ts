import { describe, expect, it } from "vitest";
import { EnemyDraftSchema, EnemySchema } from "./enemy";

const enemy = {
  v: 1, name: "Robed Chorister", concept: "A cultist who borrows the voices of the drowned.",
  role: "standard",
  stats: { hp: 10, defense: 12, attack_bonus: 3, speed: 6, damage_dice: "1d6" },
  weakness: "radiant", resistance: null,
  abilities: [],
  behavior: ["Keeps distance", "Targets the healer"],
};

describe("Enemy", () => {
  it("parses with id/threat optional", () => {
    const r = EnemySchema.parse(enemy);
    expect(r.loot_hint).toBe("");
    expect(EnemySchema.safeParse({ ...enemy, id: "en_chorister", threat: 13.5 }).success).toBe(true);
  });
  it("rejects bad input", () => {
    expect(EnemySchema.safeParse({ ...enemy, extra: 1 }).success).toBe(false);
    expect(EnemySchema.safeParse({ ...enemy, behavior: ["one"] }).success).toBe(false);
    expect(EnemySchema.safeParse({ ...enemy, stats: { ...enemy.stats, damage_dice: "2d7" } }).success).toBe(false);
    expect(EnemySchema.safeParse({ ...enemy, weakness: "stunned" }).success).toBe(true);
    expect(EnemySchema.safeParse({ ...enemy, resistance: "stunned" }).success).toBe(false);
    expect(EnemySchema.safeParse({ ...enemy, id: "x_1" }).success).toBe(false);
  });
  it("minions have no abilities", () => {
    const ab = { name: "A", description: "d", action: "action", target: "enemy", range_tiles: 1, cooldown_turns: 1, effects: [{ type: "disarm" }] };
    expect(EnemyDraftSchema.safeParse({ ...enemy, role: "minion", abilities: [ab] }).success).toBe(false);
    expect(EnemyDraftSchema.safeParse({ ...enemy, role: "elite", abilities: [ab] }).success).toBe(true);
  });
});
