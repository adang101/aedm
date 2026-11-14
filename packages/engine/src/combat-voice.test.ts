import { describe, expect, it } from "vitest";
import { BODY_PLANS } from "@aedm/schemas";
import { barkFor, creatureVoice, groupFoes, narrateCombatEnd, narrateCombatStart, victoryNeedsDm, type BarkEvent, type CreatureVoice } from "./combat-voice.ts";
import { COMBAT_VOICE } from "./data.ts";
import { createRng } from "./rng.ts";
import { chorister, makeWorld, spawn, withArchetype, withState } from "./testkit.ts";

const voice = (over: Partial<CreatureVoice> = {}): CreatureVoice => ({ name: "Brute", role: "standard", body: "humanoid", fearless: false, cowardly: false, ...over });
const EVENTS: BarkEvent[] = [
  { type: "morale_broken", entityId: "e", name: "Brute", reason: "hurt" },
  { type: "morale_broken", entityId: "e", name: "Brute", reason: "leader_down" },
  { type: "surrendered", entityId: "e", name: "Brute" },
  { type: "fled", entityId: "e", name: "Brute" },
  { type: "bloodied", entityId: "e", entityName: "Brute" },
];

describe("narrateCombatStart", () => {
  it("is deterministic, names the foes with counts and the first mover, and invents no numbers", () => {
    const info = { foes: ["Marsh Brute A", "Marsh Brute B", "Marsh Brute C", "Wolf"], starter: "Mara", first: { name: "Tov", side: "party" as const } };
    const a = narrateCombatStart(info, createRng(4));
    expect(a).toBe(narrateCombatStart(info, createRng(4)));
    expect(a).toContain("Marsh Brute (x3)");
    expect(a).toContain("Wolf");
    expect(a).toContain("Mara");
    expect(a).toContain("Tov");
    for (let seed = 0; seed < 20; seed++) for (const n of narrateCombatStart(info, createRng(seed)).match(/\d+/g) ?? []) expect(n).toBe("3");
  });
  it("works without a starter or a first mover, and varies across seeds", () => {
    const outs = new Set<string>();
    for (let seed = 0; seed < 30; seed++) {
      const t = narrateCombatStart({ foes: ["Wolf"] }, createRng(seed));
      expect(t).toContain("Wolf");
      expect(t).not.toMatch(/[{}]/);
      outs.add(t);
    }
    expect(outs.size).toBeGreaterThan(1);
    expect(narrateCombatStart({ foes: [] }, createRng(1))).toBe("");
  });
  it("uses the enemy-first phrasing when a foe moves first", () => {
    const t = narrateCombatStart({ foes: ["Wolf"], first: { name: "Wolf", side: "enemy" } }, createRng(2));
    expect(t.match(/Wolf/g)!.length).toBeGreaterThanOrEqual(2);
  });
});

describe("groupFoes", () => {
  it("strips spawn letters, groups and joins", () => {
    expect(groupFoes(["Rat A", "Rat B"])).toBe("Rat (x2)");
    expect(groupFoes(["Rat A", "Wolf", "Rat B", "Crow"])).toBe("Rat (x2), Wolf and Crow");
    expect(groupFoes(["Wolf"])).toBe("Wolf");
  });
});

describe("narrateCombatEnd", () => {
  it("covers a clean win, fled, surrendered and downed allies", () => {
    expect(narrateCombatEnd({ fell: 3, fled: 0, surrendered: 0, partyDown: [] }, createRng(1))).toMatch(/last|silence|over/i);
    expect(narrateCombatEnd({ fell: 1, fled: 2, surrendered: 0, partyDown: [] }, createRng(1))).toContain("2");
    expect(narrateCombatEnd({ fell: 0, fled: 1, surrendered: 1, partyDown: [] }, createRng(1))).toMatch(/One/);
    expect(narrateCombatEnd({ fell: 1, fled: 0, surrendered: 0, partyDown: ["Mara", "Tov"] }, createRng(1))).toContain("Mara and Tov");
  });
  it("never invents numbers and leaves no braces", () => {
    for (let seed = 0; seed < 20; seed++) {
      const t = narrateCombatEnd({ fell: 4, fled: 2, surrendered: 3, partyDown: [] }, createRng(seed));
      expect(t).not.toMatch(/[{}]/);
      for (const n of t.match(/\d+/g) ?? []) expect(["2", "3"]).toContain(n);
    }
  });
});

describe("victoryNeedsDm", () => {
  it("an ordinary victory does not need the DM", () => {
    expect(victoryNeedsDm({ leaderInvolved: false, partyDown: [] })).toBe(false);
  });
  it("a boss or elite in the fight, or a party member still down, does", () => {
    expect(victoryNeedsDm({ leaderInvolved: true, partyDown: [] })).toBe(true);
    expect(victoryNeedsDm({ leaderInvolved: false, partyDown: ["Mara"] })).toBe(true);
  });
});

describe("barkFor", () => {
  it("humanoids speak: short, generic lines for every event", () => {
    for (const e of EVENTS) {
      for (const info of [voice(), voice({ cowardly: true }), voice({ fearless: true }), voice({ role: "boss" })]) {
        for (let seed = 0; seed < 30; seed++) {
          const b = barkFor(e, info, createRng(seed));
          if (!b) continue;
          expect(b.kind).toBe("say");
          expect(b.text.split(/\s+/).length).toBeLessThanOrEqual(12);
          expect(b.text).not.toMatch(/[{}]/);
        }
      }
    }
  });
  it("always barks for morale, surrender and flight; bloodied only some of the time", () => {
    for (const e of EVENTS.slice(0, 4)) for (let seed = 0; seed < 20; seed++) expect(barkFor(e, voice(), createRng(seed))).not.toBeNull();
    const bloodied = EVENTS[4]!;
    const got = Array.from({ length: 60 }, (_, seed) => barkFor(bloodied, voice(), createRng(seed)));
    expect(got.some((b) => b === null)).toBe(true);
    expect(got.some((b) => b !== null)).toBe(true);
  });
  it("non-talkers emote with their name, never speak", () => {
    for (const body of BODY_PLANS.filter((b) => !COMBAT_VOICE.talkingBodies.includes(b))) {
      for (const e of EVENTS.slice(0, 4)) {
        const b = barkFor(e, voice({ name: "Marsh Hound", body }), createRng(3));
        expect(b?.kind, `${body} ${e.type}`).toBe("emote");
        expect(b?.text).toContain("Marsh Hound");
      }
    }
  });
  it("is deterministic and varied", () => {
    const e = EVENTS[2]!;
    expect(barkFor(e, voice(), createRng(5))).toEqual(barkFor(e, voice(), createRng(5)));
    const outs = new Set(Array.from({ length: 40 }, (_, s) => barkFor(e, voice(), createRng(s))?.text));
    expect(outs.size).toBeGreaterThan(2);
  });
  it("picks the cowardly, fearless and leader flavors", () => {
    const say = COMBAT_VOICE.say;
    const lines = (ev: BarkEvent, info: CreatureVoice) => new Set(Array.from({ length: 80 }, (_, s) => barkFor(ev, info, createRng(s))?.text).filter(Boolean));
    for (const t of lines(EVENTS[0]!, voice({ cowardly: true }))) expect(say.morale_broken!.cowardly).toContain(t);
    for (const t of lines(EVENTS[1]!, voice())) expect(say.morale_broken!.leader_down).toContain(t);
    for (const t of lines(EVENTS[4]!, voice({ fearless: true }))) expect(say.bloodied!.fearless).toContain(t);
    for (const t of lines(EVENTS[4]!, voice({ role: "elite" }))) expect(say.bloodied!.leader).toContain(t);
  });
  it("has no proper nouns, gore or digits in any spoken line, and every template placeholder is known", () => {
    const spoken = Object.values(COMBAT_VOICE.say).flatMap((f) => Object.values(f).flat());
    for (const t of spoken) {
      expect(t.split(/\s+/).length, t).toBeLessThanOrEqual(12);
      expect(t, t).not.toMatch(/\d|[{}]|blood|gore|kill|die\b|dead/i);
    }
    const allowed: Record<string, string[]> = {
      start_opening: ["foes"], start_opening_starter: ["starter", "foes"], start_first_party: ["first"], start_first_enemy: ["first"],
      end_cleared: [], end_fled_one: [], end_fled_many: ["count"], end_yield_one: [], end_yield_many: ["count"], end_downed: ["names"],
    };
    expect(Object.keys(COMBAT_VOICE.templates).sort()).toEqual(Object.keys(allowed).sort());
    for (const [k, list] of Object.entries(COMBAT_VOICE.templates)) for (const t of list) for (const m of t.matchAll(/\{(\w+)\}/g)) expect(allowed[k]).toContain(m[1]);
    for (const group of Object.values(COMBAT_VOICE.emote)) for (const ev of Object.values(group)) for (const list of Object.values(ev)) for (const t of list) expect(t).toContain("{name}");
    for (const body of BODY_PLANS) expect(COMBAT_VOICE.emoteGroups[body], body).toBeTruthy();
  });
});

describe("creatureVoice", () => {
  it("reads role, body plan and tactics from the archetype", () => {
    const w = makeWorld(3);
    const reg = withArchetype(w.state, { ...chorister, role: "elite", behavior: ["Never flees, fights to the end"] });
    const state = spawn(reg.state, w.rng, reg.id, 5, 5);
    const ent = Object.values(state.entities).find((e) => e.kind === "enemy")!;
    const v = creatureVoice(state, ent)!;
    expect(v).toMatchObject({ name: ent.name, role: "elite", fearless: true, cowardly: false });
    expect(typeof v.body).toBe("string");
  });
  it("is null for a party member and falls back to the default body for shape sprites", () => {
    const w = makeWorld(3);
    const reg = withArchetype(w.state);
    const state0 = spawn(reg.state, w.rng, reg.id, 5, 5);
    const ent = Object.values(state0.entities).find((e) => e.kind === "enemy")!;
    const state = withState(state0, (s) => { s.entities[ent.id]!.sprite = { kind: "shape", shape: "hex", color: "#c0562b", accent: "#3a2a1e", glyph: "B" }; });
    expect(creatureVoice(state, state.entities[ent.id]!)!.body).toBe(COMBAT_VOICE.defaultBody);
    const pc = Object.values(state.entities).find((e) => e.kind === "pc")!;
    expect(creatureVoice(state, pc)).toBeNull();
  });
});
