import { describe, expect, it } from "vitest";
import { fixtures, type DmAction, type MapBrief } from "@aedm/schemas";
import { applyDmActions, computePartyLevel, type DmContext } from "./dm-actions.ts";
import { describeEvent } from "./events.ts";
import { createRng } from "./rng.ts";
import { addMap, type GameState } from "./state.ts";
import { PARTY_IDS, makeTestMap, makeWorld, withArchetype } from "./testkit.ts";

const CTX: DmContext = { presentCharacterIds: PARTY_IDS, partyLevel: 1 };
const apply = (state: GameState, actions: DmAction[], ctx: DmContext = CTX, seed = 3) => applyDmActions(state, createRng(seed), actions, ctx);

const npc = (name: string, x = 5, y = 5, mapId = "m_lighthouse"): DmAction => ({
  type: "create_npc", name, concept: "A local.", role: "bystander", map_id: mapId, x, y, sprite_tags: ["coat"],
});

describe("request_check", () => {
  it("is returned as a pending check with the DC clamped; bad targets are rejected", () => {
    const { state } = makeWorld();
    const r = apply(state, [
      { type: "request_check", target: "ch_brindle", ability: "int", dc: 99, tags: ["explosives"], advantage: "none", reason: "inspect the lock" },
      { type: "request_check", target: "ch_nobody", ability: "int", dc: 10, tags: [], advantage: "none", reason: "x" },
      { type: "request_check", target: "party", ability: "dex", dc: 1, tags: [], advantage: "disadvantage", reason: "sneak" },
    ]);
    expect(r.pendingChecks).toHaveLength(2);
    expect(r.pendingChecks[0]).toMatchObject({ target: "ch_brindle", dc: 30, tags: ["explosives"] });
    expect(r.pendingChecks[1]).toMatchObject({ target: "party", dc: 5, advantage: "disadvantage" });
    expect(r.rejected).toHaveLength(1);
    expect(r.applied).toHaveLength(2);
  });
});

describe("npcs", () => {
  it("create_npc needs a walkable free tile and a unique living name", () => {
    const { state } = makeWorld(7, { walls: [[9, 9]] });
    const first = apply(state, [npc("Odalys Brand")]);
    expect(first.rejected).toHaveLength(0);
    const id = Object.keys(first.state.npcs)[0]!;
    expect(first.state.entities[id]).toMatchObject({ kind: "npc", name: "Odalys Brand", disposition: "neutral" });
    expect(first.state.facts).toContainEqual({ subject: "Odalys Brand", predicate: "is_alive", object: "true" });
    const second = apply(first.state, [
      npc("odalys brand", 6, 6), // duplicate living name
      npc("Edda", 9, 9),         // wall
      npc("Edda", 5, 5),         // occupied
      npc("Hollow Pell", 7, 7),  // the facts say he is dead
      npc("Elsewhere", 5, 5, "m_missing"),
      npc("Ferris", 8, 8),
    ]);
    expect(second.rejected.map((x) => x.reason)).toHaveLength(5);
    expect(second.applied).toHaveLength(1);
  });

  it("npc_say works for a living npc in the scene and is rejected for a dead one", () => {
    const { state } = makeWorld();
    const created = apply(state, [npc("Odalys Brand")]);
    const id = Object.keys(created.state.npcs)[0]!;
    const say = apply(created.state, [{ type: "npc_say", entity_id: id, text: "Three villagers walk in their sleep." }]);
    expect(say.applied).toHaveLength(1);
    expect(say.events[0]).toMatchObject({ type: "npc_said", name: "Odalys Brand" });
    const dead = apply(created.state, [
      { type: "set_fact", subject: "Odalys Brand", predicate: "is_alive", object: "false" },
      { type: "npc_say", entity_id: id, text: "I am not dead." },
    ]);
    expect(dead.applied).toHaveLength(1);
    expect(dead.rejected).toHaveLength(1);
    expect(dead.rejected[0]!.reason).toMatch(/dead/);
    expect(dead.state.entities[id]).toBeUndefined();
    expect(dead.state.npcs[id]!.alive).toBe(false);
  });

  it("npc_say is rejected when the facts say the speaker is dead, for unknown ids and for pcs", () => {
    const { state } = makeWorld();
    const s = JSON.parse(JSON.stringify(state)) as GameState;
    s.entities.pell = { ...s.entities.ch_orrin!, id: "pell", kind: "npc", name: "Hollow Pell", refId: "pell" };
    const r = apply(s, [
      { type: "npc_say", entity_id: "pell", text: "Hello." },
      { type: "npc_say", entity_id: "nobody", text: "Hello." },
      { type: "npc_say", entity_id: "ch_orrin", text: "Hello." },
    ]);
    expect(r.rejected).toHaveLength(3);
    expect(r.rejected[0]!.reason).toMatch(/dead/);
  });
});

describe("set_fact", () => {
  it("rejects bringing the dead back (Hollow Pell is_alive false -> true) but allows death", () => {
    const { state } = makeWorld();
    const r = apply(state, [
      { type: "set_fact", subject: "Hollow Pell", predicate: "is_alive", object: "true" },
      { type: "set_fact", subject: "Odalys Brand", predicate: "is_alive", object: "false" },
      { type: "set_fact", subject: "Odalys Brand", predicate: "is_alive", object: "true" },
    ]);
    expect(r.rejected.map((x) => x.action)).toEqual([
      { type: "set_fact", subject: "Hollow Pell", predicate: "is_alive", object: "true" },
      { type: "set_fact", subject: "Odalys Brand", predicate: "is_alive", object: "true" },
    ]);
    expect(r.state.facts.find((f) => f.subject === "Hollow Pell")!.object).toBe("false");
    expect(r.state.facts.find((f) => f.subject === "Odalys Brand" && f.predicate === "is_alive")!.object).toBe("false");
  });
  it("located_at must be a known map; disposition overwrites; free predicates append without duplicates", () => {
    const { state } = makeWorld();
    const r = apply(state, [
      { type: "set_fact", subject: "Odalys Brand", predicate: "located_at", object: "m_nowhere" },
      { type: "set_fact", subject: "Odalys Brand", predicate: "located_at", object: "m_lighthouse" },
      { type: "set_fact", subject: "Odalys Brand", predicate: "disposition", object: "wary" },
      { type: "set_fact", subject: "Odalys Brand", predicate: "knows", object: "three villagers sleepwalk" },
      { type: "set_fact", subject: "Odalys Brand", predicate: "knows", object: "three villagers sleepwalk" },
      { type: "set_fact", subject: "Odalys Brand", predicate: "knows", object: "the key is behind the bar" },
    ]);
    expect(r.rejected).toHaveLength(1);
    const f = r.state.facts.filter((x) => x.subject === "Odalys Brand");
    expect(f.filter((x) => x.predicate === "disposition")).toEqual([{ subject: "Odalys Brand", predicate: "disposition", object: "wary" }]);
    expect(f.filter((x) => x.predicate === "knows")).toHaveLength(2);
    expect(f.filter((x) => x.predicate === "located_at")).toHaveLength(1);
  });
  it("cannot declare a player character dead", () => {
    const { state } = makeWorld();
    const r = apply(state, [{ type: "set_fact", subject: "Tamsin Quickfoot", predicate: "is_alive", object: "false" }]);
    expect(r.rejected).toHaveLength(1);
  });
});

describe("grant_item and the loot cap", () => {
  const item = (name: string, value: number, kind: "consumable" | "weapon" | "armor" | "trinket" | "quest" = "trinket", tier?: number): DmAction => ({
    type: "grant_item", recipient: "ch_orrin", item: { name, kind, value, ...(tier ? { tier } : {}) },
  });
  it("level 1 cap is 30: values add up across grants and over-cap grants are rejected", () => {
    const { state } = makeWorld();
    const r = apply(state, [item("Silver locket", 20), item("Ring", 11), item("Coin", 10), item("Old key", 99, "quest"), item("Pearl", 31)]);
    expect(r.applied.map((a) => (a as { item: { name: string } }).item.name)).toEqual(["Silver locket", "Coin", "Old key"]);
    expect(r.rejected).toHaveLength(2);
    expect(r.rejected[0]!.reason).toMatch(/loot cap/);
    expect(r.state.session.lootValueThisEncounter).toBe(30);
    const inv = r.state.characters.ch_orrin!.inventory;
    expect(new Set(inv.map((i) => i.id)).size).toBe(3);
    expect(inv.find((i) => i.name === "Old key")!.value).toBe(0); // quest items are free
  });
  it("level 1 rejects weapons above tier 1; allows tier 1 and auto-equips a better one", () => {
    const { state } = makeWorld();
    const r = apply(state, [item("Fine sword", 10, "weapon", 2), item("Plain sword", 5, "weapon", 1)]);
    expect(r.rejected).toHaveLength(1);
    expect(r.state.characters.ch_orrin!.inventory).toHaveLength(1);
    const high = apply(state, [item("Fine sword", 10, "weapon", 2)], { ...CTX, partyLevel: 3 });
    expect(high.rejected).toHaveLength(0);
    expect(high.state.characters.ch_orrin!.weapon_tier).toBe(2);
  });
  it("rejects absent recipients", () => {
    const { state } = makeWorld();
    expect(apply(state, [item("x", 1)], { ...CTX, presentCharacterIds: ["ch_brindle"] }).rejected).toHaveLength(1);
  });
});

describe("growth", () => {
  const award = (amount: number, id = "ch_orrin"): DmAction => ({ type: "award_growth", character_id: id, amount, reason: "kindness" });
  it("caps at 50 points per character per session", () => {
    const { state } = makeWorld();
    const r = apply(state, [award(25), award(25), award(1)]);
    expect(r.applied).toHaveLength(2);
    expect(r.rejected).toHaveLength(1);
    expect(r.state.characters.ch_orrin!.growth).toBe(50);
    expect(r.state.session.growthAwarded.ch_orrin).toEqual({ points: 50, count: 2 });
  });
  it("caps at 3 awards per character per session; other characters have their own caps", () => {
    const { state } = makeWorld();
    const r = apply(state, [award(5), award(5), award(5), award(5), award(5, "ch_tamsin")]);
    expect(r.applied).toHaveLength(4);
    expect(r.rejected).toHaveLength(1);
    expect(r.state.characters.ch_tamsin!.growth).toBe(5);
  });
  it("complete_milestone grants 100 to each present character, once; level-ups recompute HP", () => {
    const { state } = makeWorld();
    const first = apply(state, [{ type: "complete_milestone", milestone_id: "m1" }], { ...CTX, presentCharacterIds: ["ch_orrin", "ch_tamsin"] });
    expect(first.rejected).toHaveLength(0);
    expect(first.state.characters.ch_orrin).toMatchObject({ growth: 100, level: 2, hp_max: 11 + 7 });
    expect(first.state.characters.ch_tamsin).toMatchObject({ growth: 100, level: 2 });
    expect(first.state.characters.ch_brindle).toMatchObject({ growth: 0, level: 1 });
    expect(first.state.entities.ch_orrin).toMatchObject({ hpMax: 18, hp: 18 });
    expect(first.events.filter((e) => e.type === "level_up")).toHaveLength(2);
    const second = apply(first.state, [{ type: "complete_milestone", milestone_id: "m1" }, { type: "complete_milestone", milestone_id: "nope" }]);
    expect(second.rejected).toHaveLength(2);
    expect(second.state.characters.ch_orrin!.growth).toBe(100);
  });
  it("overflow carries over and level 3 queues a score point", () => {
    const { state } = makeWorld();
    const a = apply(state, [{ type: "complete_milestone", milestone_id: "m1" }, { type: "complete_milestone", milestone_id: "m2" }, award(25)]);
    expect(a.state.characters.ch_orrin).toMatchObject({ growth: 225, level: 3 });
    expect(a.state.pendingLevelUps.ch_orrin).toEqual({ scorePoints: 1, abilityPicks: 2 });
  });
});

describe("spawn_entity and the encounter budget", () => {
  it("accepts enemies within the standard budget for 3 level-1 characters (39) and rejects beyond it", () => {
    const w = makeWorld();
    const a = withArchetype(w.state);
    const spawnAct = (count: number, x = 8): DmAction => ({ type: "spawn_entity", archetype_id: a.id, map_id: "m_lighthouse", x, y: 5, count });
    const r = apply(a.state, [spawnAct(2), spawnAct(1, 12), spawnAct(1, 14)]);
    // chorister threat is 12.75: 3 fit (38.25), the 4th would be 51
    expect(r.applied).toHaveLength(2);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]!.reason).toMatch(/budget/);
    const enemies = Object.values(r.state.entities).filter((e) => e.kind === "enemy");
    expect(enemies.map((e) => e.name)).toEqual(["Robed Chorister A", "Robed Chorister B", "Robed Chorister C"]);
    expect(new Set(enemies.map((e) => `${e.x},${e.y}`)).size).toBe(3);
    expect(enemies[0]).toMatchObject({ hp: 10, hpMax: 10, disposition: "hostile" });
  });
  it("rejects unknown archetypes, blocked tiles and unknown slots; resolves slot_id", () => {
    const w = makeWorld(7, { walls: [[12, 12]] });
    const a = withArchetype(w.state);
    const r = apply(a.state, [
      { type: "spawn_entity", archetype_id: "en_missing", map_id: "m_lighthouse", x: 5, y: 5, count: 1 },
      { type: "spawn_entity", archetype_id: a.id, map_id: "m_lighthouse", x: 12, y: 12, count: 1 },
      { type: "spawn_entity", archetype_id: a.id, map_id: "m_lighthouse", slot_id: "nope", count: 1 },
      { type: "spawn_entity", archetype_id: a.id, map_id: "m_lighthouse", slot_id: "slot_1", count: 1 },
    ]);
    expect(r.rejected).toHaveLength(3);
    expect(Object.values(r.state.entities).find((e) => e.kind === "enemy")).toMatchObject({ x: 10, y: 10 });
  });
  it("budget scales with difficulty", () => {
    const w = makeWorld();
    const a = withArchetype(w.state);
    const four: DmAction = { type: "spawn_entity", archetype_id: a.id, map_id: "m_lighthouse", x: 8, y: 5, count: 4 };
    expect(apply(a.state, [four]).rejected).toHaveLength(1);
    expect(apply(a.state, [four], { ...CTX, difficulty: "hard" }).rejected).toHaveLength(0);
  });
});

describe("combat actions", () => {
  it("start_combat includes present pcs, upgrades the difficulty to fit and end_combat clears it", () => {
    const w = makeWorld();
    const a = withArchetype(w.state);
    const spawned = apply(a.state, [{ type: "spawn_entity", archetype_id: a.id, map_id: "m_lighthouse", x: 8, y: 5, count: 3 }]).state;
    const enemy = Object.values(spawned.entities).filter((e) => e.kind === "enemy").map((e) => e.id);
    const r = apply(spawned, [{ type: "start_combat", participants: [enemy[0]!, "ch_tamsin"], difficulty: "easy" }]);
    expect(r.rejected).toHaveLength(0);
    expect(r.state.combat!.order).toHaveLength(4); // all three present pcs + the one named enemy
    // one chorister (12.75) fits the easy budget of 19.5
    expect(r.state.combat!.difficulty).toBe("easy");
    const r2 = apply(spawned, [{ type: "start_combat", participants: [...enemy, "ch_tamsin"], difficulty: "easy" }]);
    expect(r2.state.combat!.difficulty).toBe("standard");
    expect(r2.events.some((e) => e.type === "note")).toBe(true);
    const end = apply(r2.state, [{ type: "end_combat", reason: "victory" }, { type: "end_combat", reason: "victory" }]);
    expect(end.applied).toHaveLength(1);
    expect(end.rejected).toHaveLength(1);
    expect(end.state.combat).toBeNull();
  });
  it("rejects unknown participants and a second start_combat; resets the loot counter", () => {
    const w = makeWorld();
    const a = withArchetype(w.state);
    const spawned = apply(a.state, [{ type: "spawn_entity", archetype_id: a.id, map_id: "m_lighthouse", x: 8, y: 5, count: 1 }]).state;
    const enemy = Object.values(spawned.entities).find((e) => e.kind === "enemy")!.id;
    const bad = apply(spawned, [{ type: "start_combat", participants: [enemy, "nobody"], difficulty: "standard" }]);
    expect(bad.rejected).toHaveLength(1);
    const withLoot = apply(spawned, [{ type: "grant_item", recipient: "ch_orrin", item: { name: "Pearl", kind: "trinket", value: 30 } }]).state;
    expect(withLoot.session.lootValueThisEncounter).toBe(30);
    const go = apply(withLoot, [
      { type: "start_combat", participants: [enemy, "ch_tamsin"], difficulty: "standard" },
      { type: "start_combat", participants: [enemy, "ch_tamsin"], difficulty: "standard" },
    ]);
    expect(go.applied).toHaveLength(1);
    expect(go.rejected).toHaveLength(1);
    expect(go.state.session.lootValueThisEncounter).toBe(0);
  });
});

describe("quests, scenes, maps, chips", () => {
  it("update_quest updates known quests, creates new ones, rejects unknown non-new quests", () => {
    const { state } = makeWorld();
    const r = apply(state, [
      { type: "update_quest", quest_id: "q_edda", status: "active", note: "Found the ledger." },
      { type: "update_quest", quest_id: "q_missing", status: "active", note: "" },
      { type: "update_quest", quest_id: "q_choir", status: "new", note: "The Quiet Choir" },
    ]);
    expect(r.rejected).toHaveLength(1);
    expect(r.state.bible.quests.find((q) => q.id === "q_edda")!.notes).toEqual(["Found the ledger."]);
    expect(r.state.bible.quests.find((q) => q.id === "q_choir")).toMatchObject({ title: "The Quiet Choir", status: "new" });
  });
  it("generate_map and create_enemy are handed back to the server", () => {
    const { state } = makeWorld();
    const brief: MapBrief = {
      setting: { name: "Lighthouse", preset: "interior", layout: "rooms_and_corridors", environment: "indoor", mood: "dim" }, theme_tags: ["lighthouse"], size_class: "small",
      rooms: [{ id: "r1", type: "hall", size: "small", connects_to: [] }], points_of_interest: [], entity_slots: [],
      exits: [{ side: "south", label: "door" }],
    };
    const r = apply(state, [
      { type: "generate_map", brief },
      { type: "create_enemy", concept: "a robed chorister", role: "standard", setting_notes: "" },
    ]);
    expect(r.mapBriefs).toEqual([brief]);
    expect(r.enemyConcepts).toHaveLength(1);
    expect(r.applied).toHaveLength(2);
  });
  it("change_scene moves the present party to the entry spawn of a known map", () => {
    const { state } = makeWorld();
    const cellar = makeTestMap("m_cellar");
    const withMap = addMap(state, cellar).state;
    const r = apply(withMap, [
      { type: "change_scene", map_id: "m_cellar", entry: "party_start" },
      { type: "change_scene", map_id: "m_nowhere", entry: "party_start" },
      { type: "change_scene", map_id: "m_cellar", entry: "no_such_spawn" },
    ]);
    expect(r.rejected).toHaveLength(2);
    expect(r.state.currentMapId).toBe("m_cellar");
    expect(PARTY_IDS.every((id) => r.state.entities[id]!.mapId === "m_cellar")).toBe(true);
    const spots = new Set(PARTY_IDS.map((id) => `${r.state.entities[id]!.x},${r.state.entities[id]!.y}`));
    expect(spots.size).toBe(3);
  });
  it("suggest_actions emits chips", () => {
    const { state } = makeWorld();
    const r = apply(state, [{ type: "suggest_actions", chips: ["Open the door", "Ask Odalys"] }]);
    expect(r.events[0]).toEqual({ type: "chips", chips: ["Open the door", "Ask Odalys"] });
  });
});

describe("general behavior", () => {
  it("never mutates the input state and logs events", () => {
    const { state } = makeWorld();
    const before = JSON.stringify(state);
    const r = apply(state, [npc("Ferris")]);
    expect(JSON.stringify(state)).toBe(before);
    expect(r.state.log.length).toBeGreaterThan(0);
    expect(r.state.seq).toBe(state.seq + 1);
  });
  it("keeps the log bounded to 200 events", () => {
    let { state } = makeWorld();
    for (let i = 0; i < 70; i++) state = apply(state, [{ type: "suggest_actions", chips: ["a b", "c d"] }, { type: "suggest_actions", chips: ["a b", "c d"] }, { type: "suggest_actions", chips: ["a b", "c d"] }]).state;
    expect(state.log).toHaveLength(200);
  });
  it("is deterministic for the same seed and keeps rngState in sync", () => {
    const { state } = makeWorld();
    const a = apply(state, [npc("Ferris")], CTX, 5);
    const b = apply(state, [npc("Ferris")], CTX, 5);
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
    expect(a.state.rngState).not.toBe(state.rngState);
  });
  it("describeEvent produces [engine: ...] lines for every event", () => {
    const w = makeWorld();
    const a = withArchetype(w.state);
    const r = apply(a.state, [
      npc("Ferris"),
      { type: "spawn_entity", archetype_id: a.id, map_id: "m_lighthouse", x: 8, y: 5, count: 1 },
      { type: "set_fact", subject: "Ferris", predicate: "knows", object: "a secret" },
      { type: "award_growth", character_id: "ch_orrin", amount: 5, reason: "kind" },
      { type: "complete_milestone", milestone_id: "m1" },
      { type: "suggest_actions", chips: ["Go on", "Wait here"] },
      { type: "set_fact", subject: "Hollow Pell", predicate: "is_alive", object: "true" },
    ]);
    expect(r.events.length).toBeGreaterThan(8);
    for (const e of r.events) expect(describeEvent(e)).toMatch(/^\[engine: .+\]$/);
  });
  it("computePartyLevel averages down", () => {
    const { state } = makeWorld();
    expect(computePartyLevel(state, PARTY_IDS)).toBe(1);
    expect(computePartyLevel(state, [])).toBe(1);
    expect(fixtures.SPIKE_PARTY).toHaveLength(3);
  });
});
