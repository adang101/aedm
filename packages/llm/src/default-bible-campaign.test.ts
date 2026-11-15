import { describe, expect, it } from "vitest";
import { StoryBibleSchema, PLOT_PATTERNS } from "@aedm/schemas";
import { ensureCampaignPlan, validateCampaign } from "@aedm/engine";
import { LANTERN_MARSH_BIBLE, lanternMarshBible } from "./default-bible.ts";

describe("the built-in Lantern Marsh bible and its hand-written campaign plan", () => {
  it("carries a plan that is valid as written", () => {
    expect(validateCampaign(LANTERN_MARSH_BIBLE)).toEqual([]);
    const r = ensureCampaignPlan(LANTERN_MARSH_BIBLE, 1234);
    expect(r.source).toBe("plan");
    expect(r.bible).toBe(LANTERN_MARSH_BIBLE);
    expect(StoryBibleSchema.safeParse(r.bible).success).toBe(true);
    expect(r.bible.locations!.length).toBeGreaterThanOrEqual(3);
    expect(r.bible.cast!.length).toBeGreaterThanOrEqual(2);
    expect(r.bible.milestones.every((m) => m.hint && m.trigger && m.trigger.type !== "story")).toBe(true);
  });
  it("keeps a valid plan for every plot pattern the built-in bible can take", () => {
    for (const pattern of PLOT_PATTERNS) {
      const b = lanternMarshBible(pattern);
      expect(validateCampaign(b), pattern).toEqual([]);
      expect(StoryBibleSchema.safeParse(b).success, pattern).toBe(true);
      expect(ensureCampaignPlan(b, 1).source, pattern).toBe("plan");
    }
  });
  it("puts one location on each stage, in stage order", () => {
    const b = lanternMarshBible("the_quest");
    expect(b.locations!.map((l) => l.stage)).toEqual(b.plot!.stages.map((s) => s.id));
  });
});
