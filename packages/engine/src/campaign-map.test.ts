import { describe, expect, it } from "vitest";
import { MapBriefSchema, type StoryBible } from "@aedm/schemas";
import { generateMap, getObjects, validateMap } from "./map/index.ts";
import { locationExits, locationMapBrief, resolveExit, startLocation } from "./campaign-map.ts";
import { emptyCampaignBinding } from "./state.ts";
import { CAMPAIGN_BIBLE, makeWorld, withState } from "./testkit.ts";

const brief = (id: string, b: StoryBible = CAMPAIGN_BIBLE) => locationMapBrief(b, id)!;

describe("startLocation", () => {
  it("is the first location", () => {
    expect(startLocation(CAMPAIGN_BIBLE)?.id).toBe("l_square");
    expect(startLocation({ ...CAMPAIGN_BIBLE, locations: undefined })).toBeUndefined();
  });
});

describe("locationExits", () => {
  it("makes one exit per connection, forward connections east and back ones west", () => {
    expect(locationExits(CAMPAIGN_BIBLE, "l_square")).toEqual([{ side: "east", label: "To The Rotting Dock", to: "l_dock" }]);
    expect(locationExits(CAMPAIGN_BIBLE, "l_marsh")).toEqual([
      { side: "west", label: "To The Rotting Dock", to: "l_dock" },
      { side: "east", label: "To The Drowned Crypt", to: "l_crypt" },
    ]);
    expect(locationExits(CAMPAIGN_BIBLE, "l_lair")).toEqual([{ side: "west", label: "To The Drowned Crypt", to: "l_crypt" }]);
  });
  it("gives distinct sides and labels even for a crowded hub, and nothing for an unknown id", () => {
    const hub = structuredClone(CAMPAIGN_BIBLE);
    hub.locations![2]!.connects_to = ["l_dock", "l_crypt", "l_square", "l_lair"];
    const ex = locationExits(hub, "l_marsh");
    expect(ex).toHaveLength(4);
    expect(new Set(ex.map((e) => e.side)).size).toBe(4);
    expect(new Set(ex.map((e) => e.label)).size).toBe(4);
    expect(locationExits(CAMPAIGN_BIBLE, "nope")).toEqual([]);
  });
  it("keeps labels within the 32 characters an exit name holds, and unique", () => {
    const b = structuredClone(CAMPAIGN_BIBLE);
    b.locations![1]!.name = "The Extremely Long Named Place Of Rotting Docks A";
    b.locations![3]!.name = "The Extremely Long Named Place Of Rotting Docks B";
    b.locations![2]!.connects_to = ["l_dock", "l_crypt"];
    const ex = locationExits(b, "l_marsh");
    expect(ex.every((e) => e.label.length <= 32)).toBe(true);
    expect(new Set(ex.map((e) => e.label)).size).toBe(2);
  });
});

describe("locationMapBrief", () => {
  it("is undefined for an unknown location", () => {
    expect(locationMapBrief(CAMPAIGN_BIBLE, "nope")).toBeUndefined();
  });
  it("produces a valid brief for every location, in the location's own setting", () => {
    for (const l of CAMPAIGN_BIBLE.locations!) {
      const b = brief(l.id);
      expect(MapBriefSchema.safeParse(b).success, l.id).toBe(true);
      expect(b.setting).toEqual(l.setting);
      expect(b.exits.map((e) => e.label)).toEqual(locationExits(CAMPAIGN_BIBLE, l.id).map((e) => e.label));
    }
    expect(brief("l_marsh").theme_tags).toEqual(["marsh", "fog"]);
  });
  it("puts the plan's cast, enemies, boss and loose key items into slots", () => {
    const slots = (id: string) => brief(id).entity_slots.map((s) => `${s.role}:${s.count}`).sort();
    expect(slots("l_square")).toEqual(["npc:1"]);
    expect(slots("l_dock")).toEqual(["loot:1"]);
    expect(slots("l_marsh")).toEqual(["enemy:3", "npc:1"]);
    expect(slots("l_crypt")).toEqual([]);
    expect(slots("l_lair")).toEqual(["boss:1"]);
  });
  it("turns features into points of interest in the layout's rooms, and falls back to the preset's own", () => {
    const sq = brief("l_square");
    expect(sq.points_of_interest.map((p) => p.kind)).toEqual(["well", "sign"]);
    const roomIds = new Set(sq.rooms.map((r) => r.id));
    for (const p of sq.points_of_interest) expect(roomIds.has(p.room_id)).toBe(true);
    expect(brief("l_crypt").points_of_interest.length).toBeGreaterThan(0);
  });
  it("builds a real, valid map for every location, with an exit for each connection", () => {
    for (const l of CAMPAIGN_BIBLE.locations!) {
      const { map } = generateMap(brief(l.id), { seed: 11, id: `m_${l.id}` });
      expect(validateMap(map).ok, l.id).toBe(true);
      const exits = getObjects(map).filter((o) => o.type === "exit").map((o) => (o.type === "exit" ? o.name : ""));
      expect(exits.sort()).toEqual(locationExits(CAMPAIGN_BIBLE, l.id).map((e) => e.label).sort());
    }
  });
});

describe("resolveExit", () => {
  const { state } = makeWorld(7, { bible: CAMPAIGN_BIBLE });
  const bound = withState(state, (s) => { s.campaign = { ...emptyCampaignBinding(), locations: { l_marsh: "m_lighthouse", l_crypt: "m_crypt" } }; });
  it("names the location an exit leads to, and its map once built", () => {
    expect(resolveExit(bound, "m_lighthouse", "To The Drowned Crypt")).toEqual({ locationId: "l_crypt", mapId: "m_crypt" });
    expect(resolveExit(bound, "m_lighthouse", "to the rotting dock")).toEqual({ locationId: "l_dock" });
  });
  it("is undefined for an unbound map or an unknown exit", () => {
    expect(resolveExit(bound, "m_elsewhere", "To The Drowned Crypt")).toBeUndefined();
    expect(resolveExit(bound, "m_lighthouse", "North Road")).toBeUndefined();
  });
});
