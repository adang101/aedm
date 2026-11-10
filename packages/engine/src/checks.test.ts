import { describe, expect, it } from "vitest";
import { createRng } from "./rng.ts";
import { clampDc, resolveCheck } from "./checks.ts";
import { PARTY_IDS, makeWorld } from "./testkit.ts";

describe("resolveCheck", () => {
  it("adds ability modifier and +2 for a matching tag (Brindle: INT +2, explosives)", () => {
    const { state } = makeWorld();
    const hit = resolveCheck(state, createRng(1), { target: "ch_brindle", ability: "int", dc: 15, tags: ["explosives"], advantage: "none", reason: "trap" });
    const miss = resolveCheck(state, createRng(1), { target: "ch_brindle", ability: "int", dc: 15, tags: ["lore"], advantage: "none", reason: "trap" });
    expect(hit.result?.rolls[0]?.modifier).toBe(4);
    expect(miss.result?.rolls[0]?.modifier).toBe(2);
    expect(hit.result?.rolls[0]?.total).toBe(hit.result!.rolls[0]!.kept + 4);
    expect(hit.events[0]).toMatchObject({ type: "roll", kind: "check", who: "ch_brindle", target: 15 });
  });
  it("clamps the DC to 5-30", () => {
    expect(clampDc(0)).toBe(5);
    expect(clampDc(99)).toBe(30);
    const { state } = makeWorld();
    expect(resolveCheck(state, createRng(1), { target: "ch_orrin", ability: "wis", dc: 80, tags: [], advantage: "none", reason: "x" }).result?.dc).toBe(30);
  });
  it("advantage rolls two dice and keeps the best", () => {
    const { state } = makeWorld();
    const r = resolveCheck(state, createRng(3), { target: "ch_orrin", ability: "wis", dc: 10, tags: [], advantage: "advantage", reason: "x" });
    const roll = r.result!.rolls[0]!;
    expect(roll.dice).toHaveLength(2);
    expect(roll.kept).toBe(Math.max(...roll.dice));
  });
  it("party check: everyone present rolls and half or more must succeed", () => {
    const { state } = makeWorld();
    for (let seed = 0; seed < 30; seed++) {
      const r = resolveCheck(state, createRng(seed), { target: "party", ability: "dex", dc: 12, tags: [], advantage: "none", reason: "sneak" }, { presentCharacterIds: PARTY_IDS });
      const res = r.result!;
      expect(res.rolls).toHaveLength(3);
      expect(res.needed).toBe(2);
      expect(res.success).toBe(res.successes >= 2);
      expect(r.events.filter((e) => e.type === "roll")).toHaveLength(3);
    }
  });
  it("rejects an absent target", () => {
    const { state } = makeWorld();
    const r = resolveCheck(state, createRng(1), { target: "ch_orrin", ability: "wis", dc: 10, tags: [], advantage: "none", reason: "x" }, { presentCharacterIds: ["ch_brindle"] });
    expect(r.result).toBeNull();
    expect(r.events[0]?.type).toBe("action_rejected");
  });
  it("is deterministic and syncs rngState", () => {
    const { state } = makeWorld();
    const a = resolveCheck(state, createRng(9), { target: "party", ability: "str", dc: 10, tags: [], advantage: "none", reason: "x" });
    const b = resolveCheck(state, createRng(9), { target: "party", ability: "str", dc: 10, tags: [], advantage: "none", reason: "x" });
    expect(a.result).toEqual(b.result);
    expect(a.state.rngState).toBe(b.state.rngState);
    expect(a.state.rngState).not.toBe(state.rngState);
  });
});
