/** Story versus map: which places and objects a narration names, and whether the map or the plan has them. */
import { describe, expect, it } from "vitest";
import type { MapObject } from "@aedm/schemas";
import { locationMapBrief } from "./campaign-map.ts";
import { knownThings, scoreNarration, scoreText, type KnownThings } from "./consistency.ts";
import { addMap } from "./map-state.ts";
import { generateMap, mapLandmarks } from "./map/index.ts";
import { CAMPAIGN_BIBLE, makeWorld } from "./testkit.ts";

const known = (map: string[], plan: string[] = []): KnownThings => ({ map: new Set(map), plan: new Set(plan) });
const nouns = (list: { noun: string }[]): string[] => list.map((m) => m.noun);

describe("scoreText", () => {
  it("grounds a mention the map has and flags one it does not", () => {
    const s = scoreText("You pry at the chest. Across the bridge, a tavern glows.", known(["chest"]));
    expect(nouns(s.mentions)).toEqual(["chest", "bridge", "tavern"]);
    expect(nouns(s.ungrounded)).toEqual(["bridge", "tavern"]);
    expect(s.ungrounded[0]?.sentence).toBe("Across the bridge, a tavern glows.");
  });

  it("folds synonyms and plurals into one noun", () => {
    const s = scoreText("Two inns face the old alehouse, and the coffers stand open.", known(["tavern"]));
    expect(nouns(s.mentions)).toEqual(["tavern", "tavern", "chest"]);
    expect(nouns(s.ungrounded)).toEqual(["chest"]);
  });

  it("skips a mention the sentence denies", () => {
    const s = scoreText("There is no chest here. You see nothing like a bridge. Without a door, the hall lies open.", known([]));
    expect(s.mentions).toEqual([]);
  });

  it("counts a place that is elsewhere in the plan apart from an invented one", () => {
    const s = scoreText("The lighthouse waits beyond the marsh, past a ruined tower.", known([], ["lighthouse"]));
    expect(s.mentions.map((m) => m.grounded)).toEqual(["plan", "none"]);
    expect(nouns(s.ungrounded)).toEqual(["tower"]);
  });

  it("matches whole words only, whatever the case", () => {
    const s = scoreText("The CHEST sits by a signal fire; she resigns herself to the wellspring.", known(["chest"]));
    expect(nouns(s.mentions)).toEqual(["chest"]);
  });

  it("is deterministic and gives a rate of 1 for text that names nothing", () => {
    expect(scoreText("Fog rolls in.", known([])).groundedRate).toBe(1);
    const text = "A gate, a well and a statue.";
    expect(scoreText(text, known(["gate"]))).toEqual(scoreText(text, known(["gate"])));
    expect(scoreText(text, known(["gate"])).groundedRate).toBeCloseTo(1 / 3);
  });
});

describe("knownThings", () => {
  const chest: MapObject = { type: "interactable", id: "ch_1", kind: "chest", state: "closed", x: 4, y: 4 };

  it("knows the interactables and the people on the map", () => {
    const { state } = makeWorld(7, { objects: [chest] });
    const k = knownThings(state, "m_lighthouse");
    expect(k.map.has("chest")).toBe(true);
    expect(k.map.has("lever")).toBe(false);
    expect(nouns(scoreNarration(state, "m_lighthouse", "You open the chest beside the lever.").ungrounded)).toEqual(["lever"]);
  });

  it("knows the landmarks of a generated map and the named places of the plan", () => {
    const loc = CAMPAIGN_BIBLE.locations![0]!;
    const map = generateMap(locationMapBrief(CAMPAIGN_BIBLE, loc.id)!, { seed: 5, id: "m_loc" }).map;
    const state = addMap(makeWorld(7, { bible: CAMPAIGN_BIBLE }).state, map).state;
    const k = knownThings(state, "m_loc");
    const lms = mapLandmarks(map);
    expect(lms.length).toBeGreaterThan(0);
    for (const l of lms) for (const w of l.name.toLowerCase().split(/\s+/)) expect(k.map.has(w) || w.length < 3).toBe(true);
    for (const other of CAMPAIGN_BIBLE.locations!.slice(1)) {
      for (const w of other.name.toLowerCase().split(/[^a-z]+/).filter((x) => x.length >= 3)) expect(k.plan.has(w) || k.map.has(w)).toBe(true);
    }
  });

  it("knows nothing of a map that does not exist", () => {
    const { state } = makeWorld();
    expect(knownThings(state, "m_nowhere").map.size).toBe(0);
  });
});
