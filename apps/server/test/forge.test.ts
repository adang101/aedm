import { describe, expect, it } from "vitest";
import { abilityCost, levelCaps } from "@aedm/engine";
import { createFakeProvider, LlmError, type ModelProvider } from "@aedm/llm";
import { bibleCampaign, forgeCharacterAbilities, forgeOneAbility, ForgeError, pitchCampaign } from "../src/forge";

const refusing: ModelProvider = {
  name: "refusing",
  complete: async () => { throw new LlmError("Model provider error (403): Requests from referer <empty> are blocked.", "api", false, { status: 403 }); },
};
const sleep = async (): Promise<void> => {};

describe("forge model failures", () => {
  it("reports the provider error to the host and tells the player to try again, not to reword", async () => {
    const seen: unknown[] = [];
    const create = { name: "Ash", title: "Ranger", description: "", ability_texts: ["Arrow volley"] } as unknown as Parameters<typeof forgeCharacterAbilities>[1];
    const err = await forgeCharacterAbilities(refusing, create, { sleep, retryBackoffMs: 0, onModelError: (e) => seen.push(e) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForgeError);
    expect((err as Error).message).toContain("Try again in a moment");
    expect((err as Error).message).not.toContain("rewording");
    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toContain("403");
  });

  it("reports level-up forge failures too", async () => {
    const seen: unknown[] = [];
    await expect(forgeOneAbility(refusing, { concept: "x", text: "y", level: 2, maxCost: 100 }, { sleep, retryBackoffMs: 0, onModelError: (e) => seen.push(e) }))
      .rejects.toBeInstanceOf(ForgeError);
    expect(seen).toHaveLength(1);
  });
});

describe("forge budget targeting and context", () => {
  const heavy = JSON.stringify({
    v: 1, name: "Reality Chorus", description: "A chord that shakes the ground.", tags: [], action: "action", target: "tile", range_tiles: 6, cooldown_turns: 0,
    effects: [
      { type: "damage", shape: "burst", radius_tiles: 1, dice: "2d6", damage_type: "fire", save: { ability: "con", dc: "caster_dc" }, on_save: "half" },
      { type: "condition", condition: "stunned", duration_turns: 1, on: "failed_save", save: { ability: "con", dc: "caster_dc" } },
    ],
  });
  const recording = () => createFakeProvider(async () => heavy);
  const userOf = (p: ReturnType<typeof recording>, i: number) => p.requests[i]!.messages[0]!.content;
  const create = { name: "Ash", title: "Ranger", description: "", ability_texts: ["one", "two", "three"] } as unknown as Parameters<typeof forgeCharacterAbilities>[1];
  const opts = { sleep, retryBackoffMs: 0 };

  it("forges each ability against an even share of the budget and keeps all of them", async () => {
    const p = recording();
    const out = await forgeCharacterAbilities(p, create, opts);
    const budget = levelCaps(1).budget;
    expect(out.abilities).toHaveLength(3);
    expect(out.abilities.reduce((n, a) => n + abilityCost(a), 0)).toBeLessThanOrEqual(budget);
    expect(out.notices.filter((n) => n.startsWith("Forged"))).toHaveLength(3);
    expect(out.notices.some((n) => n.startsWith("Dropped"))).toBe(false);
    expect(abilityCost(out.abilities[0]!)).toBeLessThanOrEqual(Math.floor(budget / 3));
    expect(userOf(p, 0)).toContain(`at most ${Math.floor(budget / 3)}`);
    const spent = abilityCost(out.abilities[0]!);
    expect(userOf(p, 1)).toContain(`at most ${Math.floor((budget - spent) / 2)}`);
    // later calls see the character's own earlier abilities
    expect(userOf(p, 1)).toContain(`this character: "Reality Chorus"`);
  });

  it("never promises more than the engine's per-ability cap", async () => {
    const p = recording();
    const single = { ...create, ability_texts: ["one"] } as typeof create;
    await forgeCharacterAbilities(p, single, opts);
    expect(userOf(p, 0)).toContain(`at most ${levelCaps(1).perAbilityCap}.`);
  });

  it("phrases the engine's adjustments as sentences for the player", async () => {
    const out = await forgeCharacterAbilities(recording(), create, opts);
    expect(out.notices[0]).toMatch(/^Forged "Reality Chorus" \(cost \d+ of 30\)\. .*\.$/);
    expect(out.notices[0]).toContain("to fit your power budget");
  });

  it("level-up forges against the remaining budget and passes campaign and party context", async () => {
    const p = recording();
    const bible = { title: "The Drowned City", digest: "Tides swallow the harbor.", tone: "grim" };
    await forgeOneAbility(p, {
      concept: "Ash", text: "Chord", level: 2, maxCost: 9,
      context: { campaign: bibleCampaign(bible), party: [{ owner: "Brindle", name: "Shaped Charge", summary: "2d6 fire damage" }] },
    }, opts);
    const user = userOf(p, 0);
    expect(user).toContain("total power budget is 35");
    expect(user).toContain("at most 9");
    expect(user).toContain("Title: The Drowned City");
    expect(user).toContain("Tone: grim");
    expect(user).toContain('Brindle: "Shaped Charge"');
    expect(user).toContain("<cost_guide>");
  });

  it("uses the pitch as the campaign before a bible exists, and nothing when there is none", () => {
    expect(pitchCampaign("  Fog and lanterns  ")).toEqual({ digest: "Fog and lanterns" });
    expect(pitchCampaign("   ")).toBeUndefined();
  });
});
