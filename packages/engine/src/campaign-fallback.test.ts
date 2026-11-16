import { describe, expect, it } from "vitest";
import { PLOT_PATTERNS, PLOT_ARCS, StoryBibleSchema, type StoryBible } from "@aedm/schemas";
import { buildFallbackCampaign, ensureCampaignPlan } from "./campaign-fallback.ts";
import { triggerOf, validateCampaign, isMachineTrigger } from "./campaign.ts";
import { locationMapBrief } from "./campaign-map.ts";
import { PLOTS } from "./data.ts";
import { generateMap, validateMap } from "./map/index.ts";
import { buildPlot, validateBiblePlot } from "./plot.ts";
import { BIBLE, CAMPAIGN_BIBLE, PLOT_BIBLE } from "./testkit.ts";

/** A bible with a plot of the pattern, `per` placeholder milestones per stage, and a pitch that can steer the theme. */
function plotBible(pattern: (typeof PLOT_PATTERNS)[number], per = 1, over: Partial<StoryBible> = {}): StoryBible {
  const plot = buildPlot(pattern, PLOT_ARCS[0]);
  return {
    ...BIBLE, ...over, plot,
    milestones: plot.stages.flatMap((st, i) => Array.from({ length: per }, (_, j) => ({ id: `m${i * per + j + 1}`, description: `Beat ${i + 1}.${j + 1} of the story.`, completed: false, stage: st.id }))),
  };
}

describe("buildFallbackCampaign", () => {
  it("gives every pattern a plan that parses and passes validateCampaign", () => {
    for (const pattern of PLOT_PATTERNS) {
      for (const per of [1, 2, 3]) {
        for (const seed of [1, 42, 9001]) {
          const out = buildFallbackCampaign(plotBible(pattern, per), seed);
          expect(validateCampaign(out), `${pattern} x${per} seed ${seed}`).toEqual([]);
          expect(validateBiblePlot(out)).toEqual([]);
          expect(StoryBibleSchema.safeParse(out).success, `${pattern} x${per}`).toBe(true);
        }
      }
    }
  });
  it("works for the shared test bibles too (two milestones per stage)", () => {
    expect(validateCampaign(buildFallbackCampaign(PLOT_BIBLE, 3))).toEqual([]);
  });
  it("is deterministic in the seed and varies with it", () => {
    const a = buildFallbackCampaign(plotBible("the_quest"), 5);
    expect(buildFallbackCampaign(plotBible("the_quest"), 5)).toEqual(a);
    const names = new Set([1, 2, 3, 4, 5, 6].map((s) => JSON.stringify(buildFallbackCampaign(plotBible("the_quest"), s).locations!.map((l) => l.name))));
    expect(names.size).toBeGreaterThan(1);
  });
  it("derives the plan from the plot: one location per stage in order, a chain, the hub first and the lair last", () => {
    const b = buildFallbackCampaign(plotBible("overcoming_the_monster"), 7);
    expect(b.locations!.map((l) => l.stage)).toEqual(b.plot!.stages.map((s) => s.id));
    b.locations!.forEach((l, i) => expect(l.connects_to).toEqual(i < b.locations!.length - 1 ? [b.locations![i + 1]!.id] : []));
    expect(b.cast![0]!.role).toBe("quest_giver");
    expect(b.cast![0]!.location).toBe(b.locations![0]!.id);
    const last = b.encounters!.at(-1)!;
    expect(last.location).toBe(b.locations!.at(-1)!.id);
    expect(last.groups.some((g) => g.role === "boss")).toBe(true);
    expect(b.ending!.goal.length).toBeGreaterThan(0);
  });
  it("sets machine-checkable triggers and keeps the bible's own milestone facts", () => {
    const src = plotBible("overcoming_the_monster");
    src.milestones[1]!.completed = true;
    src.milestones[2]!.hint = "Keep this hint";
    const b = buildFallbackCampaign(src, 7);
    expect(b.milestones.map((m) => [m.id, m.description, m.completed, m.stage])).toEqual(src.milestones.map((m) => [m.id, m.description, m.completed, m.stage]));
    expect(b.milestones[2]!.hint).toBe("Keep this hint");
    expect(triggerOf(b.milestones[0]!).type).toBe("talk_to");
    expect(triggerOf(b.milestones.at(-1)!).type).toBe("defeat_encounter");
    expect(b.milestones.every((m) => isMachineTrigger(triggerOf(m)))).toBe(true);
    expect(b.plot).toEqual(src.plot);
    expect(src.locations).toBeUndefined();
  });
  it("never triggers a milestone that is already true at the start", () => {
    for (const pattern of PLOT_PATTERNS) {
      const b = buildFallbackCampaign(plotBible(pattern, 3), 2);
      const t = b.milestones.map(triggerOf).find((x) => x.type === "reach_location");
      expect(t && t.type === "reach_location" && t.location === b.locations![0]!.id).toBeFalsy();
    }
  });
  it("leaves extra milestones of a stage to the DM (story)", () => {
    const b = buildFallbackCampaign(plotBible("the_quest", 3), 4);
    const first = b.milestones.filter((m) => m.stage === b.plot!.stages[0]!.id).map((m) => triggerOf(m).type);
    expect(first).toEqual(["talk_to", "story", "story"]);
  });
  it("takes the setting from the story's own words when they name one", () => {
    const b = buildFallbackCampaign(plotBible("overcoming_the_monster", 1, { title: "The Lantern Marsh", digest: "A drowned marsh where fog hides the bog." }), 3);
    const presets = b.locations!.map((l) => l.setting.preset);
    expect(presets.filter((p) => p === "swamp").length).toBeGreaterThanOrEqual(2);
    expect(presets[0]).not.toBe("swamp");
  });
  it("copes with short plots by adding side locations up to the minimum", () => {
    const one: StoryBible = { ...BIBLE, plot: { pattern: "comedy", arc: "rise", stages: [{ id: "order_disturbed", title: "T", goal: "G" }] }, milestones: [{ id: "m1", description: "d", completed: false, stage: "order_disturbed" }] };
    const b = buildFallbackCampaign(one, 1);
    expect(b.locations!.length).toBeGreaterThanOrEqual(3);
    expect(validateCampaign(b)).toEqual([]);
    const two: StoryBible = { ...one, plot: { ...one.plot!, stages: [{ id: "order_disturbed", title: "T", goal: "G" }, { id: "confusion", title: "U", goal: "H" }] }, milestones: [{ id: "m1", description: "d", completed: false, stage: "order_disturbed" }, { id: "m2", description: "e", completed: false, stage: "confusion" }] };
    expect(validateCampaign(buildFallbackCampaign(two, 1))).toEqual([]);
  });
  it("sizes encounters from the stage's difficulty", () => {
    const b = buildFallbackCampaign(plotBible("overcoming_the_monster"), 7);
    const stageDifficulty = (id: string) => PLOTS.patterns.overcoming_the_monster.stages.find((s) => s.id === id)!.difficulty;
    expect(stageDifficulty("early_success")).toBe("standard");
    const early = b.encounters!.find((e) => e.stage === "early_success")!;
    expect(early.groups.map((g) => `${g.role}:${g.count}`)).toEqual(["minion:2", "standard:1"]);
  });
  it("returns the bible unchanged (a copy) when it has no plot", () => {
    const out = buildFallbackCampaign(BIBLE, 1);
    expect(out).toEqual(BIBLE);
    expect(out).not.toBe(BIBLE);
  });
  it("builds locations the map generator accepts, with valid maps (every pattern)", () => {
    for (const pattern of PLOT_PATTERNS) {
      const b = buildFallbackCampaign(plotBible(pattern), 13);
      for (const l of b.locations!) {
        const brief = locationMapBrief(b, l.id)!;
        const { map } = generateMap(brief, { seed: 5, id: `m_${l.id}` });
        expect(validateMap(map).ok, `${pattern} ${l.id}`).toBe(true);
      }
    }
  });
});

describe("ensureCampaignPlan", () => {
  it("keeps a valid plan untouched", () => {
    const r = ensureCampaignPlan(CAMPAIGN_BIBLE, 1);
    expect(r.source).toBe("plan");
    expect(r.bible).toBe(CAMPAIGN_BIBLE);
    expect(r.reasons).toEqual([]);
  });
  it("adds the fallback to a bible without a plan", () => {
    const r = ensureCampaignPlan(plotBible("tragedy"), 1);
    expect(r.source).toBe("fallback");
    expect(validateCampaign(r.bible)).toEqual([]);
    expect(r.reasons).toEqual([]);
  });
  it("replaces an invalid plan, saying why", () => {
    const bad = structuredClone(CAMPAIGN_BIBLE);
    bad.cast![0]!.location = "nowhere";
    const r = ensureCampaignPlan(bad, 1);
    expect(r.source).toBe("fallback");
    expect(r.reasons.join()).toContain("unknown location nowhere");
    expect(validateCampaign(r.bible)).toEqual([]);
    expect(r.bible.title).toBe(bad.title);
  });
  it("leaves a bible with no plot alone and says so", () => {
    const r = ensureCampaignPlan(BIBLE, 1);
    expect(r.source).toBe("none");
    expect(r.bible).toBe(BIBLE);
    expect(r.reasons.join()).toMatch(/no plot/);
  });
});
