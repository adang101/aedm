import { describe, expect, it } from "vitest";
import type { StoryBible } from "@aedm/schemas";
import { StoryBibleSchema } from "@aedm/schemas";
import { CAMPAIGN } from "./data.ts";
import { campaignNeighbors, hasCampaignPlan, isMachineTrigger, triggerOf, validateCampaign } from "./campaign.ts";
import { BIBLE, CAMPAIGN_BIBLE } from "./testkit.ts";

const edit = (fn: (b: StoryBible) => void): StoryBible => {
  const b = structuredClone(CAMPAIGN_BIBLE);
  fn(b);
  return b;
};
const reasons = (b: StoryBible) => validateCampaign(b).join(" | ");

describe("campaign.json", () => {
  it("has sane thresholds", () => {
    expect(CAMPAIGN.limits.minLocations).toBeLessThanOrEqual(CAMPAIGN.limits.maxLocations);
    expect(CAMPAIGN.limits.maxConnections).toBeLessThanOrEqual(4);
    expect(CAMPAIGN.checkable.minPct).toBeGreaterThan(0);
    expect(CAMPAIGN.checkable.minPct).toBeLessThanOrEqual(100);
  });
});

describe("the fixture", () => {
  it("is a valid bible and a valid campaign", () => {
    expect(StoryBibleSchema.safeParse(CAMPAIGN_BIBLE).success).toBe(true);
    expect(validateCampaign(CAMPAIGN_BIBLE)).toEqual([]);
    expect(hasCampaignPlan(CAMPAIGN_BIBLE)).toBe(true);
  });
  it("a bible without a plan has nothing to validate", () => {
    expect(hasCampaignPlan(BIBLE)).toBe(false);
    expect(validateCampaign(BIBLE)).toEqual([]);
  });
});

describe("triggers", () => {
  it("a missing trigger is a story trigger and only story is not machine-checkable", () => {
    expect(triggerOf({ id: "m", description: "x", completed: false })).toEqual({ type: "story" });
    expect(isMachineTrigger({ type: "story" })).toBe(false);
    expect(isMachineTrigger({ type: "talk_to", cast: "c" })).toBe(true);
    expect(isMachineTrigger({ type: "reach_location", location: "l" })).toBe(true);
  });
});

describe("campaignNeighbors", () => {
  it("treats connections as two-way, in list order", () => {
    expect(campaignNeighbors(CAMPAIGN_BIBLE, "l_marsh")).toEqual(["l_dock", "l_crypt"]);
    expect(campaignNeighbors(CAMPAIGN_BIBLE, "l_square")).toEqual(["l_dock"]);
    const one = edit((b) => { b.locations![0]!.connects_to = []; b.locations![1]!.connects_to = ["l_marsh"]; });
    expect(campaignNeighbors(one, "l_square")).toEqual([]);
    expect(campaignNeighbors(one, "l_dock")).toEqual(["l_marsh"]);
  });
});

describe("validateCampaign: structure", () => {
  it("needs a plot", () => {
    expect(reasons(edit((b) => { delete b.plot; }))).toContain("plot");
  });
  it("needs locations, within the data's count", () => {
    expect(reasons(edit((b) => { b.locations = []; }))).toContain("locations");
    expect(reasons(edit((b) => { b.locations = b.locations!.slice(0, 2); b.locations[1]!.connects_to = ["l_square"]; }))).toMatch(/at least 3 locations/);
    expect(reasons(edit((b) => { delete b.locations; }))).toContain("locations");
  });
  it("needs unique location ids and known connections", () => {
    expect(reasons(edit((b) => { b.locations![1]!.id = "l_square"; }))).toContain("duplicate location id l_square");
    expect(reasons(edit((b) => { b.locations![0]!.connects_to = ["nowhere"]; }))).toContain("unknown location nowhere");
    expect(reasons(edit((b) => { b.locations![0]!.connects_to = ["l_square"]; }))).toContain("connects to itself");
  });
  it("needs every location reachable from the first", () => {
    expect(reasons(edit((b) => { b.locations![2]!.connects_to = ["l_crypt"]; b.locations![1]!.connects_to = ["l_square"]; }))).toMatch(/not reachable from the first location.*l_marsh/);
  });
  it("limits connections per location", () => {
    expect(reasons(edit((b) => {
      const extra = ["a", "b", "c", "d"].map((id) => ({ ...b.locations![4]!, id: `x_${id}`, connects_to: ["l_marsh"], stage: "frustration" }));
      b.locations!.splice(3, 0, ...extra);
    }))).toMatch(/l_marsh has \d connections/);
  });
  it("needs locations in stage order and every stage covered", () => {
    expect(reasons(edit((b) => { b.locations![3]!.stage = "call"; }))).toContain("stage order");
    expect(reasons(edit((b) => { b.locations![3]!.stage = "frustration"; }))).toContain("stage nightmare has no location");
    expect(reasons(edit((b) => { b.locations![1]!.stage = "unknown_stage"; }))).toContain("unknown stage unknown_stage");
  });
  it("limits the number of locations", () => {
    expect(reasons(edit((b) => {
      for (let i = 0; i < 4; i++) b.locations!.push({ ...b.locations![4]!, id: `z${i}`, connects_to: ["l_lair"] });
    }))).toMatch(/at most 8 locations/);
  });
});

describe("validateCampaign: references", () => {
  it("checks cast", () => {
    expect(reasons(edit((b) => { b.cast![0]!.location = "nowhere"; }))).toContain("cast c_tam: unknown location nowhere");
    expect(reasons(edit((b) => { b.cast![1]!.id = "c_tam"; }))).toContain("duplicate cast id c_tam");
    expect(reasons(edit((b) => { b.cast![1]!.name = "old tam"; }))).toContain("share the name");
  });
  it("checks encounters", () => {
    expect(reasons(edit((b) => { b.encounters![0]!.location = "nowhere"; }))).toContain("encounter e_sentries: unknown location nowhere");
    expect(reasons(edit((b) => { b.encounters![0]!.stage = "nope"; }))).toContain("encounter e_sentries: unknown stage nope");
    expect(reasons(edit((b) => { b.encounters![0]!.groups[0]!.count = 6; b.encounters![0]!.groups[1]!.count = 6; }))).toMatch(/encounter e_sentries has 12 creatures/);
    expect(reasons(edit((b) => { b.encounters![1]!.groups[0]!.count = 2; }))).toContain("at most 1 boss");
    expect(reasons(edit((b) => { b.encounters![1]!.id = "e_sentries"; }))).toContain("duplicate encounter id e_sentries");
  });
  it("checks key items and their holders", () => {
    expect(reasons(edit((b) => { b.key_items![0]!.location = "nowhere"; }))).toContain("key item k_lens: unknown location nowhere");
    expect(reasons(edit((b) => { b.key_items![1]!.held_by = { kind: "cast", id: "ghost" }; }))).toContain("key item k_signet: unknown cast ghost");
    expect(reasons(edit((b) => { b.key_items![1]!.held_by = { kind: "encounter", id: "ghost" }; }))).toContain("key item k_signet: unknown encounter ghost");
    expect(reasons(edit((b) => { b.key_items![1]!.location = "l_dock"; }))).toContain("held by c_wren, who is at l_marsh");
    expect(reasons(edit((b) => { b.key_items![1]!.held_by = { kind: "encounter", id: "e_sentries" }; }))).toEqual("");
  });
  it("needs an ending", () => {
    expect(reasons(edit((b) => { delete b.ending; }))).toContain("ending");
  });
  it("checks every trigger's target", () => {
    const t = (trigger: NonNullable<StoryBible["milestones"][number]["trigger"]>) => reasons(edit((b) => { b.milestones[0]!.trigger = trigger; }));
    expect(t({ type: "talk_to", cast: "ghost" })).toContain("milestone m1: unknown cast ghost");
    expect(t({ type: "reach_location", location: "ghost" })).toContain("milestone m1: unknown location ghost");
    expect(t({ type: "defeat_encounter", encounter: "ghost" })).toContain("milestone m1: unknown encounter ghost");
    expect(t({ type: "obtain_item", item: "ghost" })).toContain("milestone m1: unknown key item ghost");
  });
  it("rejects a trigger that is already true when the story starts", () => {
    expect(reasons(edit((b) => { b.milestones[0]!.trigger = { type: "reach_location", location: "l_square" }; }))).toContain("already reached when the story starts");
  });
});

describe("validateCampaign: machine-checkable milestones", () => {
  it("needs a reasonable share of milestones to be machine-checkable", () => {
    const allStory = edit((b) => { for (const m of b.milestones) delete m.trigger; });
    expect(reasons(allStory)).toMatch(/0 of 6 milestones/);
    // 3 of 6 is exactly 50 percent: fine; 2 of 6 is not
    const half = edit((b) => { delete b.milestones[0]!.trigger; delete b.milestones[1]!.trigger; });
    expect(reasons(half)).toBe("");
    const third = edit((b) => { delete b.milestones[0]!.trigger; delete b.milestones[1]!.trigger; delete b.milestones[2]!.trigger; });
    expect(reasons(third)).toMatch(/only 2 of 6 milestones/);
  });
  it("needs a machine-checkable milestone in the final stage", () => {
    expect(reasons(edit((b) => { b.milestones[5]!.trigger = { type: "story" }; }))).toContain("final stage final_confrontation has no machine-checkable milestone");
  });
});
