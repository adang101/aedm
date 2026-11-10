import { describe, expect, it } from "vitest";
import { StateSnapshotPayload, fixtures, type CharacterCreate } from "@aedm/schemas";
import { addCharacter, createGameState, toSnapshot } from "./state.ts";
import { BIBLE, FACTS, makeWorld } from "./testkit.ts";

const create = (over: Partial<CharacterCreate> = {}): CharacterCreate => ({
  v: 1, name: "Newcomer", title: "", description: "", key_ability: "str",
  scores: { str: 15, dex: 14, con: 14, int: 10, wis: 10, cha: 8 },
  trait_tags: ["athletics", "survival"],
  sprite_recipe: { kind: "shape", shape: "square", color: "#112233", accent: "#445566", glyph: "N" },
  abilities: [fixtures.fixtureAbility("Mending Poultice")],
  ...over,
});

describe("addCharacter", () => {
  const base = createGameState({ seed: 1, bible: BIBLE, facts: FACTS, contentRating: "teen" });

  it("adds the spike party with computed hp and assigned owner", () => {
    let s = base;
    for (const c of fixtures.SPIKE_PARTY) {
      const r = addCharacter(s, c, "u_" + c.id);
      expect(r.ok).toBe(true);
      if (r.ok) { s = r.state; expect(r.character.hp_max).toBe(c.hp_max); expect(r.character.user_id).toBe("u_" + c.id); }
    }
    expect(Object.keys(s.characters)).toHaveLength(3);
  });

  it("does not mutate the input state", () => {
    const before = JSON.stringify(base);
    addCharacter(base, fixtures.BRINDLE, "u1");
    expect(JSON.stringify(base)).toBe(before);
  });

  it("creates a character from a CharacterCreate with a counter id, level 1", () => {
    // point buy: 15 (9) + 14 (7) + 14 (7) + 10 (2) + 10 (2) + 8 (0) = 27
    const exact = addCharacter(base, create({ scores: { str: 15, dex: 14, con: 14, int: 10, wis: 10, cha: 8 } }), "u1");
    expect(exact.ok).toBe(true);
    if (exact.ok) {
      expect(exact.character.id).toMatch(/^ch_\d+$/);
      expect(exact.character.level).toBe(1);
      expect(exact.character.hp_max).toBe(12);
      expect(exact.character.abilities[0]?.cost).toBe(3);
      expect(exact.character.abilities[0]?.id).toMatch(/^ab_/);
    }
  });

  it("assigns the same ids on a replay", () => {
    const sc = { str: 15, dex: 14, con: 14, int: 10, wis: 10, cha: 8 };
    const a = addCharacter(base, create({ scores: sc }), "u1");
    const b = addCharacter(base, create({ scores: sc }), "u1");
    expect(a.ok && b.ok && a.character.id === b.character.id).toBe(true);
  });

  it("rejects wrong point buy, ability_texts, and over-budget abilities", () => {
    expect(addCharacter(base, create({ scores: { str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 } }), "u").ok).toBe(false);
    const forge = addCharacter(base, { ...create({ scores: { str: 15, dex: 14, con: 14, int: 10, wis: 10, cha: 8 } }), abilities: undefined, ability_texts: ["a big blast"] }, "u");
    expect(forge.ok).toBe(false);
    const sc = fixtures.fixtureAbility("Shaped Charge");
    const over = addCharacter(base, create({ scores: { str: 15, dex: 14, con: 14, int: 10, wis: 10, cha: 8 }, abilities: [sc, sc, sc] }), "u");
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.errors.join(" ")).toMatch(/budget/);
  });

  it("rejects a duplicate character id", () => {
    const r1 = addCharacter(base, fixtures.BRINDLE, "u");
    if (!r1.ok) throw new Error("setup");
    expect(addCharacter(r1.state, fixtures.BRINDLE, "u").ok).toBe(false);
  });
});

describe("toSnapshot", () => {
  it("produces a valid state_snapshot payload", () => {
    const { state } = makeWorld();
    const snap = toSnapshot(state);
    expect(snap).not.toBeNull();
    expect(StateSnapshotPayload.safeParse(snap).success).toBe(true);
    expect(snap?.entities).toHaveLength(3);
    expect(snap?.party[0]).not.toHaveProperty("user_id");
    expect(snap?.mode).toBe("exploration");
  });
  it("is null without a map", () => {
    expect(toSnapshot(createGameState({ seed: 1, bible: BIBLE, facts: [], contentRating: "teen" }))).toBeNull();
  });
});
