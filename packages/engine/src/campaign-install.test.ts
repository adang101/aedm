import { describe, expect, it } from "vitest";
import type { Enemy, StoryBible } from "@aedm/schemas";
import { addMap } from "./map-state.ts";
import { generateMap, getObjects } from "./map/index.ts";
import { locationMapBrief } from "./campaign-map.ts";
import { installLocationContent, locationEnemyRequests } from "./campaign-install.ts";
import { openContainer, takeAll } from "./inventory.ts";
import { trackObjectives } from "./objectives.ts";
import { placePartyOnMap, campaignOf, type GameState } from "./state.ts";
import { CAMPAIGN_BIBLE, chorister, makeWorld, PARTY_IDS, placeAt } from "./testkit.ts";

const minion: Enemy = { ...chorister, name: "Marsh Thrall", role: "minion" };
const standard: Enemy = { ...chorister, name: "Choir Sentry", role: "standard" };
const boss: Enemy = { ...chorister, name: "The Choirmaster", role: "boss" };
const archetypes = { e_sentries: [minion, standard], e_boss: [boss] };

function fresh(bible: StoryBible = CAMPAIGN_BIBLE): GameState {
  return makeWorld(7, { bible }).state;
}
/** Generate and add the location's map, then install its content. */
function build(s: GameState, locationId: string, mapId: string, input: Parameters<typeof installLocationContent>[3] = { archetypes }, seed = 3) {
  const map = generateMap(locationMapBrief(s.bible, locationId)!, { seed, id: mapId }).map;
  const added = addMap(s, map).state;
  return installLocationContent(added, locationId, mapId, input);
}

describe("locationEnemyRequests", () => {
  it("lists what the enemy builder must make for a location, one per group, in order", () => {
    expect(locationEnemyRequests(CAMPAIGN_BIBLE, "l_marsh")).toEqual([
      { encounterId: "e_sentries", group: 0, concept: "A cultist who borrows the voices of the drowned", role: "minion", count: 2 },
      { encounterId: "e_sentries", group: 1, concept: "A choir sentry in drowned robes", role: "standard", count: 1 },
    ]);
    expect(locationEnemyRequests(CAMPAIGN_BIBLE, "l_square")).toEqual([]);
    expect(locationEnemyRequests(CAMPAIGN_BIBLE, "nope")).toEqual([]);
  });
});

describe("installLocationContent: cast", () => {
  it("binds the location and places its cast NPC on a free walkable tile of the map", () => {
    const r = build(fresh(), "l_square", "m_sq");
    expect(r.value.ok).toBe(true);
    const b = campaignOf(r.state);
    expect(b.locations).toEqual({ l_square: "m_sq" });
    const id = b.cast.c_tam!;
    expect(r.value.cast).toEqual([{ id: "c_tam", entityId: id }]);
    const npc = r.state.npcs[id]!;
    expect(npc).toMatchObject({ name: "Old Tam", role: "quest_giver", map_id: "m_sq", voice: "gruff, nautical", alive: true, disposition: "friendly" });
    const ent = r.state.entities[id]!;
    expect(ent).toMatchObject({ kind: "npc", mapId: "m_sq", x: npc.x, y: npc.y });
    expect(r.events.map((e) => e.type)).toContain("npc_created");
    expect(r.state.facts).toContainEqual({ subject: "Old Tam", predicate: "located_at", object: "m_sq" });
  });
  it("puts the cast near the map's npc slot", () => {
    const r = build(fresh(), "l_square", "m_sq");
    const map = r.state.maps.m_sq!;
    const slot = getObjects(map).find((o) => o.type === "entity_slot" && o.role === "npc")!;
    const npc = r.state.npcs[campaignOf(r.state).cast.c_tam!]!;
    expect(Math.max(Math.abs(npc.x - slot.x), Math.abs(npc.y - slot.y))).toBeLessThanOrEqual(3);
  });
  it("gives an allied cast member combat stats", () => {
    const r = build(fresh(), "l_marsh", "m_marsh");
    const wren = r.state.npcs[campaignOf(r.state).cast.c_wren!]!;
    expect(wren.role).toBe("ally");
    expect(wren.stats?.hp).toBeGreaterThan(0);
  });
  it("skips a cast member the engine refuses (a living namesake), and says why", () => {
    const s0 = fresh();
    const a = build(s0, "l_square", "m_sq").state;
    const dup = structuredClone(CAMPAIGN_BIBLE);
    dup.cast![1]!.name = "Old Tam";
    dup.cast![1]!.location = "l_dock";
    const r = build({ ...a, bible: dup }, "l_dock", "m_dock");
    expect(r.value.skipped).toEqual([{ kind: "cast", id: "c_wren", reason: "an NPC named Old Tam is already alive" }]);
  });
});

describe("installLocationContent: encounters", () => {
  it("registers the archetypes and spawns every group's creatures, hostile, on the map", () => {
    const r = build(fresh(), "l_marsh", "m_marsh");
    const enc = campaignOf(r.state).encounters.e_sentries!;
    expect(enc.mapId).toBe("m_marsh");
    expect(enc.entityIds).toHaveLength(3);
    const ents = enc.entityIds.map((id) => r.state.entities[id]!);
    expect(ents.every((e) => e.kind === "enemy" && e.disposition === "hostile" && e.mapId === "m_marsh")).toBe(true);
    expect(new Set(ents.map((e) => `${e.x},${e.y}`)).size).toBe(3);
    expect(ents.map((e) => r.state.archetypes[e.refId]!.role).sort()).toEqual(["minion", "minion", "standard"]);
    expect(ents.map((e) => e.name).sort()).toEqual(["Choir Sentry", "Marsh Thrall A", "Marsh Thrall B"]);
    expect(r.value.encounters).toEqual([{ id: "e_sentries", entityIds: enc.entityIds }]);
    expect(r.events.filter((e) => e.type === "entity_spawned")).toHaveLength(3);
  });
  it("keeps creatures off the party's start tile", () => {
    const r = build(fresh(), "l_marsh", "m_marsh");
    const start = getObjects(r.state.maps.m_marsh!).find((o) => o.type === "spawn" && o.name === "party_start")!;
    for (const id of campaignOf(r.state).encounters.e_sentries!.entityIds) {
      const e = r.state.entities[id]!;
      expect(e.x === start.x && e.y === start.y).toBe(false);
    }
  });
  it("skips an encounter whose archetypes are missing, wrong in number or wrong in role, and installs it on a later call", () => {
    const none = build(fresh(), "l_marsh", "m_marsh", {});
    expect(none.value.skipped).toContainEqual({ kind: "encounter", id: "e_sentries", reason: "needs 2 archetypes (one per group), got 0" });
    expect(campaignOf(none.state).encounters.e_sentries).toBeUndefined();
    const wrong = build(fresh(), "l_marsh", "m_marsh", { archetypes: { e_sentries: [standard, standard] } });
    expect(wrong.value.skipped[0]).toMatchObject({ kind: "encounter", id: "e_sentries" });
    expect(wrong.value.skipped[0]!.reason).toMatch(/group 0 is a minion/);
    const later = installLocationContent(none.state, "l_marsh", "m_marsh", { archetypes });
    expect(campaignOf(later.state).encounters.e_sentries!.entityIds).toHaveLength(3);
    expect(later.value.cast).toEqual([]);
  });
  it("reuses an archetype the server already registered", () => {
    const s0 = fresh();
    const withArch = { ...s0, archetypes: { ...s0.archetypes, en_9: { ...minion, id: "en_9" } } };
    const r = build(withArch, "l_marsh", "m_marsh", { archetypes: { e_sentries: [{ ...minion, id: "en_9" }, standard] } });
    expect(Object.keys(r.state.archetypes).filter((k) => k === "en_9")).toHaveLength(1);
    expect(r.state.archetypes.en_9!.name).toBe("Marsh Thrall");
    expect(Object.keys(r.state.archetypes)).toHaveLength(2);
  });
  it("puts a boss near the boss slot", () => {
    const r = build(fresh(), "l_lair", "m_lair");
    const ids = campaignOf(r.state).encounters.e_boss!.entityIds;
    expect(ids).toHaveLength(1);
    const slot = getObjects(r.state.maps.m_lair!).find((o) => o.type === "entity_slot" && o.role === "boss")!;
    const e = r.state.entities[ids[0]!]!;
    expect(Math.max(Math.abs(e.x - slot.x), Math.abs(e.y - slot.y))).toBeLessThanOrEqual(3);
  });
});

describe("installLocationContent: key items", () => {
  it("puts a loose key item in the location's loot pile", () => {
    const r = build(fresh(), "l_dock", "m_dock");
    const itemId = campaignOf(r.state).items.k_lens!;
    const holder = Object.values(r.state.containers).find((c) => c.items.some((i) => i.id === itemId))!;
    expect(holder.kind).toBe("pile");
    expect(holder.map_id).toBe("m_dock");
    expect(holder.items.find((i) => i.id === itemId)).toEqual({ id: itemId, name: "Lantern Lens", kind: "quest", value: 0 });
    expect(r.value.items).toEqual([{ id: "k_lens", itemId, containerId: holder.id }]);
  });
  it("puts a cast-held key item in that NPC's pockets", () => {
    const r = build(fresh(), "l_marsh", "m_marsh");
    const itemId = campaignOf(r.state).items.k_signet!;
    const owner = r.state.entities[campaignOf(r.state).cast.c_wren!]!;
    const pockets = Object.values(r.state.containers).find((c) => c.kind === "pockets" && c.owner_entity_id === owner.id)!;
    expect(pockets.items.map((i) => i.id)).toEqual([itemId]);
  });
  it("puts an encounter-held key item on its toughest creature, so it drops on defeat", () => {
    const bible = structuredClone(CAMPAIGN_BIBLE);
    bible.key_items![1]!.held_by = { kind: "encounter", id: "e_sentries" };
    const r = build(fresh(bible), "l_marsh", "m_marsh");
    const itemId = campaignOf(r.state).items.k_signet!;
    const pockets = Object.values(r.state.containers).find((c) => c.kind === "pockets" && c.items.some((i) => i.id === itemId))!;
    const owner = r.state.entities[pockets.owner_entity_id!]!;
    expect(r.state.archetypes[owner.refId]!.role).toBe("standard");
  });
  it("skips an item whose holder could not be placed, then places it once the holder exists", () => {
    const bible = structuredClone(CAMPAIGN_BIBLE);
    bible.key_items![1]!.held_by = { kind: "encounter", id: "e_sentries" };
    const none = build(fresh(bible), "l_marsh", "m_marsh", {});
    expect(none.value.skipped).toContainEqual({ kind: "item", id: "k_signet", reason: "its holder e_sentries has not been placed" });
    expect(campaignOf(none.state).items.k_signet).toBeUndefined();
    const later = installLocationContent(none.state, "l_marsh", "m_marsh", { archetypes });
    expect(campaignOf(later.state).items.k_signet).toBeDefined();
  });
});

describe("installLocationContent: safety", () => {
  it("is idempotent", () => {
    const first = build(fresh(), "l_marsh", "m_marsh");
    const again = installLocationContent(first.state, "l_marsh", "m_marsh", { archetypes });
    expect(again.value).toMatchObject({ ok: true, cast: [], encounters: [], items: [], skipped: [] });
    expect(again.events).toEqual([]);
    expect(JSON.stringify(campaignOf(again.state))).toBe(JSON.stringify(campaignOf(first.state)));
    expect(Object.keys(again.state.entities)).toEqual(Object.keys(first.state.entities));
    expect(Object.keys(again.state.containers)).toEqual(Object.keys(first.state.containers));
  });
  it("is deterministic", () => {
    const a = build(fresh(), "l_marsh", "m_marsh");
    const b = build(fresh(), "l_marsh", "m_marsh");
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
  });
  it("does not touch the input state", () => {
    const s = fresh();
    const added = addMap(s, generateMap(locationMapBrief(s.bible, "l_marsh")!, { seed: 3, id: "m_marsh" }).map).state;
    const snapshot = JSON.stringify({ ...added, maps: {} });
    installLocationContent(added, "l_marsh", "m_marsh", { archetypes });
    expect(JSON.stringify({ ...added, maps: {} })).toBe(snapshot);
  });
  it("refuses unknown locations and maps, and a location already built as another map", () => {
    const s = fresh();
    const bad = installLocationContent(s, "nope", "m_lighthouse");
    expect(bad.value).toMatchObject({ ok: false, error: "unknown location nope" });
    expect(bad.state).toBe(s);
    expect(installLocationContent(s, "l_marsh", "m_nowhere").value).toMatchObject({ ok: false, error: "unknown map m_nowhere" });
    const built = build(s, "l_marsh", "m_marsh").state;
    const other = addMap(built, generateMap(locationMapBrief(built.bible, "l_marsh")!, { seed: 9, id: "m_marsh2" }).map).state;
    expect(installLocationContent(other, "l_marsh", "m_marsh2", { archetypes }).value).toMatchObject({ ok: false, error: "location l_marsh is already built as map m_marsh" });
  });
  it("leaves a state with no plan alone", () => {
    const { state } = makeWorld(7);
    expect(installLocationContent(state, "l_marsh", "m_lighthouse").value.ok).toBe(false);
  });
});

describe("a campaign played through the engine, with no model call", () => {
  it("completes the objectives as the party talks, picks up the item, fights and travels", () => {
    let s = fresh();
    const rng = makeWorld(7).rng;
    // the start: install the first map, put the party there, and the first objective is the one the plan says
    s = build(s, "l_square", "m_sq").state;
    s = placePartyOnMap(s, "m_sq").state;
    let r = trackObjectives(s);
    s = r.state;
    expect(r.value.objective?.milestones[0]).toMatchObject({ id: "m1", hint: expect.stringMatching(/^Talk to Old Tam at the /), done: false });
    // talk
    r = trackObjectives(s, { talkedTo: [campaignOf(s).cast.c_tam!] });
    s = r.state;
    expect(r.value.lines[0]).toMatch(/^Objective complete: Talk to Old Tam at the /);
    expect(r.value.objective?.stage.id).toBe("early_success");
    // the next map: the party walks through the exit
    s = build(s, "l_dock", "m_dock").state;
    s = placePartyOnMap(s, "m_dock").state;
    const pile = Object.values(s.containers).find((c) => c.items.some((i) => i.id === campaignOf(s).items.k_lens))!;
    s = placeAt(s, PARTY_IDS[0]!, pile.x, pile.y);
    const taken = takeAll(openContainer(s, rng, PARTY_IDS[0]!, pile.id).state, rng, PARTY_IDS[0]!, pile.id);
    expect(taken.ok).toBe(true);
    r = trackObjectives(taken.state, { events: taken.events });
    s = r.state;
    expect(r.value.completed.map((c) => c.id)).toEqual(["m2"]);
    expect(r.value.objective?.stage.id).toBe("frustration");
  });
});
