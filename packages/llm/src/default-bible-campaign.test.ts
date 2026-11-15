import { describe, expect, it } from "vitest";
import { StoryBibleSchema, PLOT_PATTERNS } from "@aedm/schemas";
import { buildFallbackCampaign, ensureCampaignPlan, validateCampaign } from "@aedm/engine";
import { LANTERN_MARSH_BIBLE, lanternMarshBible } from "./default-bible.ts";

describe("the built-in Lantern Marsh bible and the offline campaign plan", () => {
  it("gets a valid plan with locations and trackable objectives", () => {
    const r = ensureCampaignPlan(LANTERN_MARSH_BIBLE, 1234);
    expect(r.source).toBe("fallback");
    expect(validateCampaign(r.bible)).toEqual([]);
    expect(StoryBibleSchema.safeParse(r.bible).success).toBe(true);
    expect(r.bible.locations!.length).toBeGreaterThanOrEqual(3);
    expect(r.bible.milestones.every((m) => m.trigger && m.trigger.type !== "story")).toBe(true);
  });
  it("works for every plot pattern the built-in bible can take", () => {
    for (const pattern of PLOT_PATTERNS) expect(validateCampaign(buildFallbackCampaign(lanternMarshBible(pattern), 5)), pattern).toEqual([]);
  });
});
