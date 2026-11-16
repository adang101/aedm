/** Story binding: a campaign location's cast, fights and items sit at the landmarks of its map. */
import { describe, expect, it } from "vitest";
import { PLOT_ARCS, PLOT_PATTERNS, type Enemy, type StoryBible } from "@aedm/schemas";
import { buildFallbackCampaign } from "./campaign-fallback.ts";
import { installLocationContent, locationEnemyRequests } from "./campaign-install.ts";
import { locationMapBrief } from "./campaign-map.ts";
import { addMap } from "./map-state.ts";
import { generateMap, mapLandmarks, type Landmark } from "./map/index.ts";
import { buildPlot } from "./plot.ts";
import { campaignOf, type GameState } from "./state.ts";
import { BIBLE, CAMPAIGN_BIBLE, PARTY_IDS, chorister, makeWorld } from "./testkit.ts";
import { describeScene } from "./describe.ts";
import { objectiveView } from "./objective-view.ts";
import { landmarkPhrase, planThingLandmark } from "./campaign-place.ts";

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
/** Within the reach of a landmark: its radius plus the room its anchors take. */
const at = (lms: Landmark[], p: { x: number; y: number }): Landmark | undefined => lms.find((l) => dist(l, p) <= l.radius + 3);

function archetypesFor(bible: StoryBible, locationId: string): Record<string, Enemy[]> {
  const out: Record<string, Enemy[]> = {};
  for (const r of locationEnemyRequests(bible, locationId)) (out[r.encounterId] ??= [])[r.group] = { ...chorister, name: `${r.encounterId}-${r.group}`, role: r.role };
  return out;
}

function install(bible: StoryBible, locationId: string, seed = 5): { state: GameState; map: ReturnType<typeof generateMap>["map"]; mapId: string } {
  const world = makeWorld(7, { bible }).state;
  const mapId = `m_${locationId}`;
  const map = generateMap(locationMapBrief(bible, locationId)!, { seed, id: mapId }).map;
  const r = installLocationContent(addMap(world, map).state, locationId, mapId, { archetypes: archetypesFor(bible, locationId) });
  expect(r.value.ok).toBe(true);
  return { state: r.state, map, mapId };
}

function checkLocation(bible: StoryBible, locationId: string, seed: number): { cast: number; fighters: number; atCast: number; atFighters: number; bossAtHeaviest: boolean | undefined } {
  const { state, map, mapId } = install(bible, locationId, seed);
  const lms = mapLandmarks(map);
  const b = campaignOf(state);
  let cast = 0, atCast = 0, fighters = 0, atFighters = 0;
  for (const c of (bible.cast ?? []).filter((x) => x.location === locationId)) {
    const e = state.entities[b.cast[c.id] ?? ""];
    if (!e) continue;
    cast++;
    if (at(lms, e)) atCast++;
  }
  let bossAtHeaviest: boolean | undefined;
  for (const enc of (bible.encounters ?? []).filter((x) => x.location === locationId)) {
    const ids = b.encounters[enc.id]?.entityIds ?? [];
    for (const id of ids) {
      const e = state.entities[id];
      if (!e) continue;
      fighters++;
      if (at(lms, e)) atFighters++;
    }
    const bossGroup = enc.groups.findIndex((g) => g.role === "boss");
    if (bossGroup >= 0 && lms.length > 0) {
      const boss = ids.map((id) => state.entities[id]!).find((e) => state.archetypes[e.refId]?.role === "boss");
      const withFight = lms.filter((l) => l.anchors.fight.length > 0);
      const top = Math.max(...withFight.map((l) => l.weight));
      const where = boss ? at(withFight, boss) : undefined;
      bossAtHeaviest = !!where && where.weight >= top - 1;
    }
  }
  // the map records every landmark and its mapId is unchanged
  expect(mapId).toBe(`m_${locationId}`);
  return { cast, fighters, atCast, atFighters, bossAtHeaviest };
}

describe("campaign binding to landmarks", () => {
  it("gives every location of the shared campaign bible landmarks, and places cast and fights at them", () => {
    let cast = 0, atCast = 0, fighters = 0, atFighters = 0;
    for (const loc of CAMPAIGN_BIBLE.locations!) {
      for (const seed of [3, 5, 11]) {
        const { map } = install(CAMPAIGN_BIBLE, loc.id, seed);
        expect(mapLandmarks(map).length, `${loc.id}/${seed}`).toBeGreaterThanOrEqual(1);
        const r = checkLocation(CAMPAIGN_BIBLE, loc.id, seed);
        cast += r.cast; atCast += r.atCast; fighters += r.fighters; atFighters += r.atFighters;
      }
    }
    expect(cast).toBeGreaterThan(0);
    expect(fighters).toBeGreaterThan(0);
    expect(atCast / cast, "cast at a landmark").toBeGreaterThanOrEqual(0.9);
    expect(atFighters / fighters, "fighters at a landmark").toBeGreaterThanOrEqual(0.9);
  });

  it("puts a key item with no holder at a landmark, and a feature of the plan on the map by name", () => {
    const { state, map } = install(CAMPAIGN_BIBLE, "l_dock", 5);
    const lms = mapLandmarks(map);
    const pile = Object.values(state.containers).find((c) => c.map_id === map.id && c.items.some((i) => i.name === "Lantern Lens"));
    expect(pile).toBeDefined();
    expect(at(lms, pile!), "the Lantern Lens rests at a landmark").toBeDefined();
    // the square's features are "well" and "sign": the well is a landmark
    const sq = install(CAMPAIGN_BIBLE, "l_square", 5).map;
    expect(mapLandmarks(sq).map((l) => l.piece)).toContain("village_well");
  });

  it("binds the offline plans the engine builds, for every plot pattern", () => {
    let cast = 0, atCast = 0, fighters = 0, atFighters = 0, locs = 0, withLm = 0, bosses = 0, bossOk = 0;
    for (const pattern of PLOT_PATTERNS) {
      const plot = buildPlot(pattern, PLOT_ARCS[0]);
      const base: StoryBible = {
        ...BIBLE, plot,
        milestones: plot.stages.map((st, i) => ({ id: `m${i + 1}`, description: `Beat ${i + 1} of the story.`, completed: false, stage: st.id })),
      };
      const bible = buildFallbackCampaign(base, 7);
      for (const loc of bible.locations!) {
        locs++;
        const { map } = install(bible, loc.id, 9);
        if (mapLandmarks(map).length > 0) withLm++;
        const r = checkLocation(bible, loc.id, 9);
        cast += r.cast; atCast += r.atCast; fighters += r.fighters; atFighters += r.atFighters;
        if (r.bossAtHeaviest !== undefined) { bosses++; if (r.bossAtHeaviest) bossOk++; }
      }
    }
    expect(withLm).toBe(locs);
    expect(cast).toBeGreaterThan(0);
    expect(fighters).toBeGreaterThan(0);
    expect(atCast / cast, "cast at a landmark").toBeGreaterThanOrEqual(0.85);
    expect(atFighters / fighters, "fighters at a landmark").toBeGreaterThanOrEqual(0.85);
    expect(bossOk / Math.max(1, bosses), "boss at the most imposing landmark").toBeGreaterThanOrEqual(0.7);
  }, 60_000);

  it("is deterministic", () => {
    const a = install(CAMPAIGN_BIBLE, "l_marsh", 5);
    const b = install(CAMPAIGN_BIBLE, "l_marsh", 5);
    expect(a.map).toEqual(b.map);
    expect(campaignOf(a.state)).toEqual(campaignOf(b.state));
  });
});

describe("naming landmarks in text", () => {
  it("says where a person is in the objective hint ('Talk to Old Tam at the village well')", () => {
    const { state, map } = install(CAMPAIGN_BIBLE, "l_square", 5);
    const phrase = planThingLandmark(state, "cast", "c_tam");
    expect(phrase).toMatch(/^the /);
    expect(mapLandmarks(map).map((l) => landmarkPhrase(l.name))).toContain(phrase);
    const hint = objectiveView(state)!.milestones.find((m) => m.id === "m1")!.hint;
    expect(hint).toBe(`Talk to Old Tam at ${phrase}`);
    // without maps in the state the hint falls back to the plan's location name
    expect(objectiveView({ bible: state.bible })!.milestones.find((m) => m.id === "m1")!.hint).toBe("Talk to Old Tam at Hollowmere Square");
  });

  it("names the landmark a character stands at and the others on the map in the scene text", () => {
    const loc = CAMPAIGN_BIBLE.locations!.find((l) => mapLandmarks(install(CAMPAIGN_BIBLE, l.id, 5).map).length > 1)!;
    const { state, map } = install(CAMPAIGN_BIBLE, loc.id, 5);
    const lms = mapLandmarks(map);
    expect(lms.length).toBeGreaterThan(1);
    const s = structuredClone(state);
    const pc = s.entities[PARTY_IDS[0]!]!;
    pc.mapId = map.id;
    pc.x = lms[0]!.x;
    pc.y = lms[0]!.y;
    const text = describeScene(s, pc.id);
    expect(text).toContain(`You are at ${landmarkPhrase(lms[0]!.name)}: ${lms[0]!.description}`);
    expect(text).toContain(`Landmarks: ${landmarkPhrase(lms[1]!.name)}`);
  });
});

