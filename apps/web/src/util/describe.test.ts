import { fixtures, type Ability } from "@aedm/schemas";
import { describe, expect, it } from "vitest";
import { describeAbility, describeEffect, modifier, signed } from "./describe";

const base: Omit<Ability, "effects"> = { v: 1, name: "Chain Spark", description: "Arcs.", tags: ["explosives"], action: "action", target: "enemy", range_tiles: 5, cooldown_turns: 2, cost: 6 };

describe("describeAbility", () => {
  it("summarises header, tags and effects in words", () => {
    const a: Ability = { ...base, tags: ["explosives"], effects: [
      { type: "damage", shape: "burst", radius_tiles: 1, dice: "2d6", damage_type: "lightning", save: { ability: "dex", dc: "caster_dc" }, on_save: "half" },
      { type: "condition", condition: "stunned", duration_turns: 1, on: "failed_save", save: { ability: "con", dc: "caster_dc" } },
    ] };
    const d = describeAbility(a);
    expect(d.header).toBe("Action - enemy, range 5 - cooldown 2 turns - cost 6");
    expect(d.tags).toEqual(["explosives"]);
    expect(d.effects[0]).toBe("Deals 2d6 lightning damage in a burst of radius 1. DEX save for half damage.");
    expect(d.effects[1]).toBe("Makes the target stunned for 1 turn (if the target fails a CON save).");
  });
  it("handles uses per rest, quick actions and self targets", () => {
    const { cooldown_turns: _cd, ...noCd } = base;
    const a: Ability = { ...noCd, action: "quick", target: "self", range_tiles: 0, uses_per_rest: 1, effects: [{ type: "shield", absorb: 5, duration_turns: 2 }] };
    expect(describeAbility(a).header).toBe("Quick action - self - 1 use per rest - cost 6");
    expect(describeAbility(a).effects).toEqual(["Shields for 5 damage for 2 turns."]);
  });
  it("describes every effect type of every fixture ability without throwing", () => {
    for (const c of fixtures.SPIKE_PARTY) for (const ab of c.abilities) {
      const d = describeAbility(ab);
      expect(d.effects.length).toBe(ab.effects.length);
      for (const line of d.effects) expect(line).toMatch(/\.$/);
    }
  });
  it("covers movement, terrain and bonus effects", () => {
    expect(describeEffect({ type: "dash", tiles: 4, with_attack: true })).toBe("Dashes up to 4 tiles and attacks.");
    expect(describeEffect({ type: "terrain", kind: "smoke", shape: "burst", radius_tiles: 1, duration_turns: 2 })).toBe("Creates smoke in a burst of radius 1 for 2 turns.");
    expect(describeEffect({ type: "check_bonus", bonus: 2, tags: ["stealth"], duration_turns: 3 })).toBe("+2 on stealth checks for 3 turns.");
    expect(describeEffect({ type: "heal", shape: "single", dice: "1d6", affects: "allies" })).toBe("Heals 1d6 to one target (allies only).");
  });
});

describe("modifier", () => {
  it("matches the engine formula", () => {
    expect([8, 9, 10, 11, 14, 15, 20].map(modifier)).toEqual([-1, -1, 0, 0, 2, 2, 5]);
    expect(signed(0)).toBe("+0");
    expect(signed(-1)).toBe("-1");
  });
});
