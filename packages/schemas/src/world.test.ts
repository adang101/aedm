import { describe, expect, it } from "vitest";
import { StoryBibleSchema } from "./world";
import { RoomSettingsPatchSchema, RoomSettingsSchema } from "./ws";

const base = {
  title: "T", digest: "D", tone: "eerie",
  milestones: [{ id: "m1", description: "x", completed: false }],
  quests: [],
};

describe("story bible plot", () => {
  it("still parses a bible without plot or milestone stages", () => {
    expect(StoryBibleSchema.safeParse(base).success).toBe(true);
  });
  it("parses a plot and milestone stages", () => {
    const r = StoryBibleSchema.safeParse({
      ...base,
      plot: { pattern: "tragedy", arc: "rise_fall", stages: [{ id: "anticipation", title: "The offer", goal: "Meet the patron." }] },
      milestones: [{ id: "m1", description: "x", completed: false, stage: "anticipation" }],
    });
    expect(r.success).toBe(true);
  });
  it("rejects unknown patterns and arcs", () => {
    const stages = [{ id: "a", title: "A", goal: "g" }];
    expect(StoryBibleSchema.safeParse({ ...base, plot: { pattern: "heist", arc: "rise", stages } }).success).toBe(false);
    expect(StoryBibleSchema.safeParse({ ...base, plot: { pattern: "comedy", arc: "sideways", stages } }).success).toBe(false);
  });
});

describe("room settings plot fields", () => {
  const s = { content_rating: "teen", campaign_pitch: "", dev_solo: false };
  it("are optional", () => {
    expect(RoomSettingsSchema.safeParse(s).success).toBe(true);
    expect(RoomSettingsSchema.safeParse({ ...s, plot_pattern: "auto", plot_arc: "fall_rise" }).success).toBe(true);
    expect(RoomSettingsPatchSchema.parse({ plot_pattern: "comedy" })).toEqual({ plot_pattern: "comedy" });
  });
  it("reject unknown ids", () => {
    expect(RoomSettingsSchema.safeParse({ ...s, plot_pattern: "heist" }).success).toBe(false);
  });
});
