import { describe, expect, it } from "vitest";
import { applyDmActions } from "./dm-actions.ts";
import { RULES } from "./data.ts";
import { trackObjectives, triggerBlocked, triggerSatisfied } from "./objectives.ts";
import { campaignOf, emptyCampaignBinding, type GameState } from "./state.ts";
import { CAMPAIGN_BIBLE, makeWorld, PARTY_IDS, withState } from "./testkit.ts";

const world = () => makeWorld(7, { bible: CAMPAIGN_BIBLE }).state;
const complete = (s: GameState, ...ids: string[]) => withState(s, (x) => { for (const m of x.bible.milestones) if (ids.includes(m.id)) m.completed = true; });
const bind = (s: GameState, fn: (b: ReturnType<typeof emptyCampaignBinding>) => void) => withState(s, (x) => { x.campaign = { ...emptyCampaignBinding(), ...x.campaign }; fn(x.campaign); });
const doneIds = (s: GameState) => s.bible.milestones.filter((m) => m.completed).map((m) => m.id);
const track = (s: GameState, input: Parameters<typeof trackObjectives>[1] = {}) => trackObjectives(s, input);

describe("trackObjectives: nothing to do", () => {
  it("returns the same state for a bible with no plan", () => {
    const { state } = makeWorld(7);
    const r = track(state);
    expect(r.state).toBe(state);
    expect(r.events).toEqual([]);
    expect(r.value.completed).toEqual([]);
  });
  it("completes nothing when no trigger is met, and is idempotent when one is", () => {
    const s = bind(world(), (b) => { b.cast.c_tam = "npc_tam"; });
    expect(doneIds(track(s).state)).toEqual([]);
    const once = track(s, { talkedTo: ["npc_tam"] });
    expect(doneIds(once.state)).toEqual(["m1"]);
    const again = track(once.state, { talkedTo: ["npc_tam"] });
    expect(again.events).toEqual([]);
    expect(again.value.completed).toEqual([]);
  });
});

describe("trackObjectives: talk_to", () => {
  const s0 = bind(world(), (b) => { b.cast.c_tam = "npc_tam"; b.cast.c_wren = "npc_wren"; });
  it("completes on a talk act with the bound NPC, reporting hint, events and lines", () => {
    const r = track(s0, { talkedTo: ["npc_tam"] });
    expect(doneIds(r.state)).toEqual(["m1"]);
    expect(r.value.completed).toEqual([{ id: "m1", hint: "Talk to Old Tam at Hollowmere Square", done: true }]);
    expect(r.value.lines).toContain("Objective complete: Talk to Old Tam at Hollowmere Square");
    expect(r.events.map((e) => e.type)).toContain("milestone_completed");
    expect(r.events.map((e) => e.type)).toContain("stage_advanced");
    expect(r.value.objective?.stage.id).toBe("early_success");
    expect(r.value.stageAdvanced).toBe(true);
    expect(campaignOf(r.state).talked).toEqual(["c_tam"]);
  });
  it("counts an NPC speaking to the party (npc_said) and ignores other NPCs", () => {
    expect(doneIds(track(s0, { talkedTo: ["npc_wren"] }).state)).toEqual([]);
    expect(doneIds(track(s0, { events: [{ type: "npc_said", entityId: "npc_tam", name: "Old Tam", text: "Hello." }] }).state)).toEqual(["m1"]);
  });
  it("awards the milestone growth to each present character, like the DM action", () => {
    const r = track(s0, { talkedTo: ["npc_tam"], presentCharacterIds: [PARTY_IDS[0] as string] });
    const grown = r.events.filter((e) => e.type === "growth_awarded");
    expect(grown).toHaveLength(1);
    expect(grown[0]).toMatchObject({ amount: RULES.growth.milestoneAward, reason: "milestone" });
    const before = s0.characters[PARTY_IDS[0] as string]!.growth;
    expect(r.state.characters[PARTY_IDS[0] as string]!.growth).toBeGreaterThan(before);
    expect(r.state.characters[PARTY_IDS[1] as string]!.growth).toBe(s0.characters[PARTY_IDS[1] as string]!.growth);
  });
  it("defaults to the characters standing on the current map", () => {
    const r = track(s0, { talkedTo: ["npc_tam"] });
    expect(r.events.filter((e) => e.type === "growth_awarded")).toHaveLength(PARTY_IDS.length);
  });
});

describe("trackObjectives: reach_location", () => {
  const atNightmare = () => bind(complete(world(), "m1", "m2", "m3", "m4"), (b) => { b.locations.l_crypt = "m_crypt"; b.locations.l_marsh = "m_marsh"; });
  it("completes when the party is on the bound map, and the stage advances", () => {
    const s = atNightmare();
    expect(doneIds(track(s).state)).toEqual(["m1", "m2", "m3", "m4"]);
    const there = withState(s, (x) => { x.currentMapId = "m_crypt"; });
    const r = track(there);
    expect(doneIds(r.state)).toContain("m5");
    expect(r.value.objective?.stage.id).toBe("final_confrontation");
    expect(campaignOf(r.state).visited).toEqual(["l_crypt"]);
  });
  it("uses scene_changed events, so a hop through a location counts", () => {
    const s = atNightmare();
    const r = track(s, { events: [{ type: "scene_changed", mapId: "m_crypt", entry: "party_start" }] });
    expect(doneIds(r.state)).toContain("m5");
  });
  it("respects stage order: a visit to a later stage's place waits, and counts once its stage comes", () => {
    const s0 = bind(complete(world(), "m1", "m2"), (b) => { b.locations.l_crypt = "m_crypt"; });
    const early = track(withState(s0, (x) => { x.currentMapId = "m_crypt"; }));
    expect(doneIds(early.state)).toEqual(["m1", "m2"]);
    expect(campaignOf(early.state).visited).toEqual(["l_crypt"]);
    const later = track(complete(withState(early.state, (x) => { x.currentMapId = "m_other"; }), "m3", "m4"));
    expect(doneIds(later.state)).toContain("m5");
  });
  it("chains: finishing a stage re-checks the new current stage in the same call", () => {
    const s = bind(complete(world(), "m1", "m2", "m3"), (b) => { b.locations.l_crypt = "m_crypt"; });
    const visited = withState(s, (x) => { x.currentMapId = "m_crypt"; x.campaign!.visited = ["l_crypt"]; });
    // m4 is a story milestone, so the stage cannot advance until the DM completes it
    expect(doneIds(track(visited).state)).toEqual(["m1", "m2", "m3"]);
    const dm = applyDmActions(visited, makeWorld(7).rng, [{ type: "complete_milestone", milestone_id: "m4" }], { presentCharacterIds: PARTY_IDS, partyLevel: 1 });
    expect(dm.rejected).toEqual([]);
    expect(doneIds(track(dm.state).state)).toContain("m5");
  });
});

describe("trackObjectives: defeat_encounter", () => {
  const atFrustration = (ids: string[]) => bind(complete(world(), "m1", "m2"), (b) => { b.encounters.e_sentries = { mapId: "m_marsh", entityIds: ids }; });
  const withFoes = (s: GameState, hp: number[], disposition: "hostile" | "wary" = "hostile") => withState(s, (x) => {
    hp.forEach((h, i) => {
      x.entities[`ei_${i}`] = { id: `ei_${i}`, kind: "enemy", name: `Foe ${i}`, mapId: "m_marsh", x: i, y: 0, hp: h, hpMax: 5, conditions: [], shield: 0, sprite: { kind: "shape", shape: "circle", color: "#112233", accent: "#445566", glyph: "F" }, refId: "en_x", disposition, cooldowns: {}, usesLeft: {}, checkBonuses: [] };
    });
  });
  it("waits while any creature stands, and completes once all are gone or down", () => {
    const standing = withFoes(atFrustration(["ei_0", "ei_1"]), [5, 5]);
    expect(doneIds(track(standing).state)).toEqual(["m1", "m2"]);
    expect(doneIds(track(withFoes(atFrustration(["ei_0", "ei_1"]), [5, 0])).state)).toEqual(["m1", "m2"]);
    const down = track(withFoes(atFrustration(["ei_0", "ei_1"]), [0, 0]));
    expect(doneIds(down.state)).toContain("m3");
    const gone = track(atFrustration(["ei_0", "ei_1"]));
    expect(doneIds(gone.state)).toContain("m3");
  });
  it("counts creatures that surrendered (no longer hostile) as dealt with", () => {
    expect(doneIds(track(withFoes(atFrustration(["ei_0"]), [3], "wary")).state)).toContain("m3");
  });
  it("never completes an encounter that spawned nothing", () => {
    expect(doneIds(track(atFrustration([])).state)).toEqual(["m1", "m2"]);
    expect(doneIds(track(withState(world(), () => undefined)).state)).toEqual([]);
  });
});

describe("trackObjectives: obtain_item", () => {
  const item = { id: "it_lens", name: "Lantern Lens", kind: "quest" as const, value: 0 };
  const holding = (s: GameState, it: typeof item) => withState(s, (x) => { x.characters[PARTY_IDS[1] as string]!.inventory.push(it); });
  const base = () => bind(complete(world(), "m1"), (b) => { b.items.k_lens = "it_lens"; });
  it("completes when anyone in the party carries the bound item, or a quest item of that name", () => {
    expect(doneIds(track(base()).state)).toEqual(["m1"]);
    expect(doneIds(track(holding(base(), item)).state)).toContain("m2");
    expect(doneIds(track(holding(base(), { ...item, id: "it_other", name: "lantern lens" })).state)).toContain("m2");
    expect(doneIds(track(holding(base(), { ...item, id: "it_other", name: "Rusty Nail" })).state)).toEqual(["m1"]);
  });
});

describe("DM complete_milestone", () => {
  const ctx = { presentCharacterIds: PARTY_IDS, partyLevel: 1 };
  const dm = (s: GameState, id: string) => applyDmActions(s, makeWorld(7).rng, [{ type: "complete_milestone", milestone_id: id }], ctx);
  it("still completes story milestones", () => {
    const r = dm(complete(world(), "m1", "m2", "m3"), "m4");
    expect(r.rejected).toEqual([]);
    expect(doneIds(r.state)).toContain("m4");
  });
  it("rejects machine-checkable milestones with a clear reason", () => {
    const r = dm(world(), "m1");
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]!.reason).toMatch(/milestone m1 is tracked by the engine.*Talk to Old Tam/);
    expect(doneIds(r.state)).toEqual([]);
  });
  it("lets the DM complete one the engine can no longer track", () => {
    const dead = bind(world(), (b) => { b.cast.c_tam = "npc_tam"; });
    const s = withState(dead, (x) => { x.npcs.npc_tam = { id: "npc_tam", name: "Old Tam", concept: "x", role: "quest_giver", map_id: "m_lighthouse", x: 1, y: 1, sprite_tags: [], alive: false }; });
    expect(dm(s, "m1").rejected).toEqual([]);
  });
});

describe("triggerBlocked", () => {
  it("is quiet for what is simply not built yet", () => {
    for (const t of [
      { type: "talk_to", cast: "c_tam" }, { type: "obtain_item", item: "k_lens" }, { type: "defeat_encounter", encounter: "e_boss" },
      { type: "reach_location", location: "l_crypt" }, { type: "story" },
    ] as const) expect(triggerBlocked(world(), t)).toBeUndefined();
  });
  it("flags a dead cast member, a creatureless encounter and a lost item", () => {
    const s = bind(world(), (b) => { b.cast.c_tam = "npc_tam"; b.encounters.e_boss = { mapId: "m_lair", entityIds: [] }; b.items.k_lens = "it_lens"; });
    const dead = withState(s, (x) => { x.npcs.npc_tam = { id: "npc_tam", name: "Old Tam", concept: "x", role: "quest_giver", map_id: "m", x: 1, y: 1, sprite_tags: [], alive: false }; });
    expect(triggerBlocked(dead, { type: "talk_to", cast: "c_tam" })).toMatch(/dead/);
    expect(triggerBlocked(s, { type: "defeat_encounter", encounter: "e_boss" })).toMatch(/no creatures/);
    expect(triggerBlocked(s, { type: "obtain_item", item: "k_lens" })).toMatch(/nobody holds/);
    const stowed = withState(s, (x) => { x.containers.cn_1 = { v: 1, id: "cn_1", kind: "pile", map_id: "m", x: 1, y: 1, items: [{ id: "it_lens", name: "Lantern Lens", kind: "quest", value: 0 }] }; });
    expect(triggerBlocked(stowed, { type: "obtain_item", item: "k_lens" })).toBeUndefined();
  });
  it("triggerSatisfied agrees with tracking", () => {
    const s = bind(world(), (b) => { b.visited = ["l_crypt"]; });
    expect(triggerSatisfied(s, { type: "reach_location", location: "l_crypt" })).toBe(true);
    expect(triggerSatisfied(s, { type: "reach_location", location: "l_marsh" })).toBe(false);
    expect(triggerSatisfied(s, { type: "story" })).toBe(false);
  });
});
