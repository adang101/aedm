import { describe, expect, it } from "vitest";
import { NARRATION } from "./data.ts";
import type { EngineEvent } from "./events.ts";
import { digestEvents, hasDramaticBeat, isDramaticEvent, narrateEvents, type DramaLookup } from "./narrate.ts";
import { createRng } from "./rng.ts";

const hit = (amount: number, over: Partial<Extract<EngineEvent, { type: "damage" }>> = {}): EngineEvent => ({
  type: "damage", target: "en_1", targetName: "Brute", source: "pc_1", sourceName: "Mara", amount, absorbed: 0, hp: 5, hpMax: 12, ...over,
});
const miss: EngineEvent = { type: "attack_missed", attacker: "en_1", attackerName: "Brute", target: "pc_1", targetName: "Mara" };

describe("narrateEvents", () => {
  it("is deterministic for a seed and uses entity names and event numbers", () => {
    const events = [hit(7), miss];
    const a = narrateEvents(events, createRng(3));
    const b = narrateEvents(events, createRng(3));
    expect(a).toBe(b);
    expect(a).toContain("Mara");
    expect(a).toContain("Brute");
    expect(a).toContain("7");
  });

  it("varies phrasing across seeds", () => {
    const outs = new Set<string>();
    for (let seed = 0; seed < 30; seed++) outs.add(narrateEvents([hit(4)], createRng(seed)));
    expect(outs.size).toBeGreaterThan(2);
  });

  it("never invents numbers: every digit run comes from the events", () => {
    const events: EngineEvent[] = [hit(7, { crit: true }), { type: "heal", target: "pc_1", targetName: "Mara", amount: 3, hp: 9, hpMax: 12 }, { type: "revived", entityId: "pc_2", entityName: "Tov", hp: 1 }];
    for (let seed = 0; seed < 20; seed++) {
      const nums = narrateEvents(events, createRng(seed)).match(/\d+/g) ?? [];
      for (const n of nums) expect(["7", "3", "1"]).toContain(n);
    }
  });

  it("covers hit, crit, miss, absorbed, down, defeated, heal, shield, condition, flee", () => {
    const cases: [EngineEvent, RegExp][] = [
      [hit(5), /Mara|Brute/],
      [hit(9, { crit: true }), /Mara|Brute/],
      [hit(0, { absorbed: 4 }), /Brute/],
      [miss, /Mara/],
      [{ type: "downed", entityId: "pc_1", entityName: "Mara" }, /Mara/],
      [{ type: "defeated", entityId: "en_1", entityName: "Brute" }, /Brute/],
      [{ type: "heal", target: "pc_1", targetName: "Mara", amount: 4, hp: 8, hpMax: 12 }, /Mara/],
      [{ type: "shield", target: "pc_1", targetName: "Mara", absorb: 5, turns: 2 }, /Mara/],
      [{ type: "condition_applied", target: "en_1", targetName: "Brute", condition: "burning", turns: 2 }, new RegExp(NARRATION.conditions.burning)],
      [{ type: "condition_ended", target: "en_1", targetName: "Brute", condition: "slowed" }, /Brute/],
      [{ type: "condition_resisted", target: "en_1", targetName: "Brute", condition: "stunned", reason: "x" }, /Brute/],
      [{ type: "ability_used", entityId: "pc_1", entityName: "Mara", abilityId: "a", abilityName: "Flare", target: "en_1", targetName: "Brute" }, /Flare/],
      [{ type: "combat_ended", reason: "flee" }, /party/i],
    ];
    for (const [e, re] of cases) {
      const out = narrateEvents([e], createRng(1));
      expect(out, e.type).toMatch(re);
      expect(out).not.toMatch(/[{}]/);
    }
  });

  it("ignores events that are not worth prose and returns an empty string", () => {
    const quiet: EngineEvent[] = [
      { type: "turn_started", entityId: "a", entityName: "A", round: 2 },
      { type: "round_started", round: 2 },
      { type: "moved", entityId: "a", entityName: "A", from: { x: 0, y: 0 }, to: { x: 1, y: 0 }, tiles: 1, reason: "walk" },
    ];
    expect(narrateEvents(quiet, createRng(1))).toBe("");
  });

  it("caps the sentence count, dropping misses first", () => {
    const events: EngineEvent[] = [];
    for (let i = 0; i < 3; i++) events.push(miss);
    for (let i = 0; i < 8; i++) events.push(hit(i + 1));
    const out = narrateEvents(events, createRng(2));
    const sentences = out.split(/(?<=\.)\s+/);
    expect(sentences.length).toBeLessThanOrEqual(NARRATION.maxSentences);
    expect(out).not.toMatch(/misses|goes wide|avoids|slips away/);
  });

  it("every template only uses placeholders its kind supplies", () => {
    const allowed: Record<string, string[]> = {
      hit: ["attacker", "target", "amount"], crit: ["attacker", "target", "amount"], hit_unsourced: ["target", "amount"],
      absorbed: ["target"], miss: ["attacker", "target"], ability: ["actor", "ability", "target"], ability_self: ["actor", "ability"],
      down: ["name"], defeated: ["name"], out: ["name"], revived: ["name", "hp"], woke: ["name", "hp"], heal: ["target", "amount"],
      heal_sourced: ["source", "target", "amount"], shield: ["target"], condition_applied: ["target", "condition"],
      condition_ended: ["target", "condition"], condition_resisted: ["target"], flee: [], truce: [],
    };
    expect(Object.keys(NARRATION.templates).sort()).toEqual(Object.keys(allowed).sort());
    for (const [k, list] of Object.entries(NARRATION.templates)) {
      expect(list.length, k).toBeGreaterThanOrEqual(2);
      for (const t of list) for (const m of t.matchAll(/\{(\w+)\}/g)) expect(allowed[k], `${k}: ${t}`).toContain(m[1]);
    }
  });
});

describe("digestEvents", () => {
  it("collapses a round into one summary line using only numbers from the events", () => {
    const line = digestEvents([hit(4), hit(3), miss, { type: "downed", entityId: "pc_1", entityName: "Mara" }, { type: "defeated", entityId: "en_1", entityName: "Brute" }], 3);
    expect(line.startsWith("[engine: round 3")).toBe(true);
    expect(line).toContain("Mara hit 2 times for 7 damage");
    expect(line).toContain("Brute missed 1 time");
    expect(line).toContain("Mara was downed");
    expect(line).toContain("Brute was defeated");
    expect(line).not.toContain("\n");
  });

  it("returns an empty string when nothing happened", () => {
    expect(digestEvents([], 2)).toBe("");
  });
});

describe("dramatic predicate", () => {
  const lookup: DramaLookup = {
    role: (id) => ({ boss1: "boss", elite1: "elite", grunt1: "standard", min1: "minion" } as const)[id as "boss1"],
    isPc: (id) => id.startsWith("pc_"),
  };
  const defeated = (id: string): EngineEvent => ({ type: "defeated", entityId: id, entityName: id });
  const downed = (id: string): EngineEvent => ({ type: "downed", entityId: id, entityName: id });

  it("a boss or elite going down is dramatic", () => {
    expect(isDramaticEvent(defeated("boss1"), lookup)).toBe(true);
    expect(isDramaticEvent(defeated("elite1"), lookup)).toBe(true);
  });
  it("standard enemies and minions going down are not", () => {
    expect(isDramaticEvent(defeated("grunt1"), lookup)).toBe(false);
    expect(isDramaticEvent(defeated("min1"), lookup)).toBe(false);
    expect(isDramaticEvent(defeated("unknown"), lookup)).toBe(false);
  });
  it("a PC dropping to 0 HP is dramatic; a non-PC downed event is not", () => {
    expect(isDramaticEvent(downed("pc_1"), lookup)).toBe(true);
    expect(isDramaticEvent(downed("grunt1"), lookup)).toBe(false);
  });
  it("ordinary events are not dramatic", () => {
    expect(isDramaticEvent(hit(5), lookup)).toBe(false);
    expect(isDramaticEvent(miss, lookup)).toBe(false);
  });
  it("hasDramaticBeat is true when any event qualifies", () => {
    expect(hasDramaticBeat([hit(1), miss], lookup)).toBe(false);
    expect(hasDramaticBeat([hit(1), defeated("boss1")], lookup)).toBe(true);
    expect(hasDramaticBeat([], lookup)).toBe(false);
  });
});
