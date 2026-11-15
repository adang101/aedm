import { describe, expect, it } from "vitest";
import { encounterBudget, enemyThreat, validateEnemy } from "@aedm/engine";
import { CAMPAIGN_BIBLE, chorister } from "@aedm/engine/testkit";
import { buildLocationMap, fitEncounter, locationMapId } from "./campaign";

const minion = { ...chorister, role: "minion" as const, abilities: [] };

describe("fitEncounter", () => {
  it("keeps a fight that already fits, clamped to the party level", () => {
    const fit = fitEncounter([{ enemy: chorister, count: 1 }], 3, 3, ["standard"]);
    expect(fit.threat).toBeLessThanOrEqual(fit.budget);
    expect(fit.level).toBe(3);
    expect(validateEnemy(fit.enemies[0]!, 3).ok).toBe(true);
  });

  it("weakens a fight that is over budget until it fits", () => {
    const groups = [{ enemy: chorister, count: 2 }, { enemy: minion, count: 1 }];
    const roles = ["standard", "minion"] as const;
    const full = fitEncounter(groups, 4, 2, roles);
    // two level-4 heroes: 2 x (10 + 12) = 22; the as-built fight would not fit at the party's level
    expect(full.budget).toBe(encounterBudget(2, 4, "standard"));
    expect(full.threat).toBeLessThanOrEqual(full.budget + 1e-9);
    expect(full.level).toBeLessThan(4);
    for (const [i, e] of full.enemies.entries()) {
      expect(validateEnemy(e, full.level).ok, e.name).toBe(true);
      expect(e.role).toBe(roles[i]);
    }
  });

  it("never goes below level 1 and reports an unfittable fight as over budget", () => {
    const fit = fitEncounter([{ enemy: chorister, count: 6 }], 1, 1, ["standard"]);
    expect(fit.level).toBe(1);
    expect(fit.threat).toBeGreaterThan(fit.budget);
    expect(fit.enemies[0]!.threat ?? enemyThreat(fit.enemies[0]!)).toBeGreaterThan(0);
  });

  it("keeps the planned role even if the clamp would change it", () => {
    const bare = { ...chorister, role: "boss" as const, abilities: [] };
    const fit = fitEncounter([{ enemy: bare, count: 1 }], 2, 4, ["boss"]);
    expect(fit.enemies[0]!.role).toBe("boss");
  });
});

describe("location maps", () => {
  const state = { seed: 99, bible: CAMPAIGN_BIBLE };
  it("builds the same map for the same game and location, with the plan's id and exits", () => {
    const a = buildLocationMap(state, "l_dock", "2026-01-01T00:00:00.000Z")!;
    const b = buildLocationMap(state, "l_dock", "2026-01-01T00:00:00.000Z")!;
    expect(a).toEqual(b);
    expect(a.id).toBe(locationMapId(CAMPAIGN_BIBLE, "l_dock"));
    expect(locationMapId(CAMPAIGN_BIBLE, "l_square")).toBe("m_start");
    expect(buildLocationMap(state, "l_nowhere", "2026-01-01T00:00:00.000Z")).toBeUndefined();
  });
  it("differs between locations and between games", () => {
    expect(buildLocationMap(state, "l_marsh", "t")!.id).not.toBe(buildLocationMap(state, "l_dock", "t")!.id);
    expect(buildLocationMap({ ...state, seed: 100 }, "l_dock", "t")).not.toEqual(buildLocationMap(state, "l_dock", "t"));
  });
});
