import { describe, expect, it } from "vitest";
import { PLOT_ARCS, PLOT_PATTERNS, StoryBibleSchema, type PlotArc, type PlotPattern, type StoryBible } from "@aedm/schemas";
import { PLOTS } from "./data.ts";
import { buildPlot, currentStage, pacingBlock, pickPlot, plotOutline, validateBiblePlot } from "./plot.ts";
import { BIBLE } from "./testkit.ts";

const plotBible = (pattern: PlotPattern = PLOT_PATTERNS[0], arc: PlotArc = PLOT_ARCS[0], done = 0): StoryBible => {
  const stages = PLOTS.patterns[pattern].stages;
  const plot = buildPlot(pattern, arc);
  return {
    ...BIBLE,
    plot,
    milestones: stages.flatMap((s, i) => [
      { id: `m${i * 2 + 1}`, description: `${s.name} a`, completed: i * 2 < done, stage: s.id },
      { id: `m${i * 2 + 2}`, description: `${s.name} b`, completed: i * 2 + 1 < done, stage: s.id },
    ]),
  };
};

describe("plots.json", () => {
  it("has seven patterns of five stages and six arcs with a fortune per stage", () => {
    expect(Object.keys(PLOTS.patterns).sort()).toEqual([...PLOT_PATTERNS].sort());
    expect(Object.keys(PLOTS.arcs).sort()).toEqual([...PLOT_ARCS].sort());
    for (const p of PLOT_PATTERNS) {
      const { stages, recommendedArcs } = PLOTS.patterns[p];
      expect(stages).toHaveLength(5);
      expect(new Set(stages.map((s) => s.id)).size).toBe(5);
      for (const s of stages) { expect(s.tension).toBeGreaterThanOrEqual(0); expect(s.tension).toBeLessThanOrEqual(10); }
      for (const a of recommendedArcs) expect(PLOT_ARCS).toContain(a);
    }
    for (const a of PLOT_ARCS) {
      expect(PLOTS.arcs[a].fortune).toHaveLength(5);
      for (const f of PLOTS.arcs[a].fortune) { expect(f).toBeGreaterThanOrEqual(PLOTS.fortune.min); expect(f).toBeLessThanOrEqual(PLOTS.fortune.max); }
    }
  });
});

describe("pickPlot", () => {
  it("is deterministic and always returns valid ids", () => {
    const a = pickPlot({ pitch: "a dragon in the hills", seed: 5 });
    expect(pickPlot({ pitch: "a dragon in the hills", seed: 5 })).toEqual(a);
    expect(PLOT_PATTERNS).toContain(a.pattern);
    expect(PLOT_ARCS).toContain(a.arc);
  });
  it("leans on pitch keywords", () => {
    for (let seed = 0; seed < 20; seed++) {
      expect(pickPlot({ pitch: "A monster stalks the lair of a dragon", seed }).pattern).toBe("overcoming_the_monster");
    }
  });
  it("keeps explicit choices and picks a recommended arc for auto", () => {
    expect(pickPlot({ pattern: "comedy", arc: "fall", pitch: "", seed: 1 })).toEqual({ pattern: "comedy", arc: "fall" });
    for (let seed = 0; seed < 20; seed++) {
      const r = pickPlot({ pattern: "tragedy", arc: "auto", pitch: "", seed });
      expect(r.pattern).toBe("tragedy");
      expect(PLOTS.patterns.tragedy.recommendedArcs).toContain(r.arc);
    }
  });
  it("varies with the seed when the pitch has no keywords", () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 60; seed++) seen.add(pickPlot({ pitch: "zzz", seed }).pattern);
    expect(seen.size).toBeGreaterThan(2);
  });
});

describe("plotOutline", () => {
  it("lists stages with tension, difficulty, fortune and trend", () => {
    const o = plotOutline("tragedy", "rise_fall");
    expect(o.map((s) => s.id)).toEqual(PLOTS.patterns.tragedy.stages.map((s) => s.id));
    expect(o[0]!.trend).toBe("up");
    expect(o[4]!.trend).toBe("down");
    expect(plotOutline("comedy", "fall")[0]!.trend).toBe("down");
  });
});

describe("validateBiblePlot", () => {
  it("accepts a legacy bible and a complete plot", () => {
    expect(validateBiblePlot(BIBLE)).toEqual([]);
    expect(validateBiblePlot(plotBible())).toEqual([]);
    expect(StoryBibleSchema.safeParse(plotBible()).success).toBe(true);
  });
  it("rejects wrong stage ids, missing milestone stages, empty stages and misordered milestones", () => {
    const b = plotBible();
    const wrongIds = { ...b, plot: { ...b.plot!, stages: b.plot!.stages.map((s, i) => (i === 0 ? { ...s, id: "nope" } : s)) } };
    expect(validateBiblePlot(wrongIds).join()).toMatch(/stage ids/);
    const untagged = { ...b, milestones: b.milestones.map((m, i) => (i === 0 ? { id: m.id, description: m.description, completed: m.completed } : m)) };
    expect(validateBiblePlot(untagged).join()).toMatch(/no stage/);
    const empty = { ...b, milestones: b.milestones.filter((m) => m.stage !== "nightmare") };
    expect(validateBiblePlot(empty).join()).toMatch(/nightmare/);
    const swapped = { ...b, milestones: [...b.milestones].reverse() };
    expect(validateBiblePlot(swapped).join()).toMatch(/order/);
    const unknown = { ...b, milestones: b.milestones.map((m, i) => (i === 0 ? { ...m, stage: "ghost" } : m)) };
    expect(validateBiblePlot(unknown).join()).toMatch(/ghost/);
  });
});

describe("currentStage and pacingBlock", () => {
  it("returns null without a plot", () => {
    expect(currentStage(BIBLE)).toBeNull();
    expect(pacingBlock(BIBLE)).toBeNull();
  });
  it("uses the stage of the first incomplete milestone", () => {
    expect(currentStage(plotBible())!.stage.id).toBe("call");
    expect(currentStage(plotBible(PLOT_PATTERNS[0], PLOT_ARCS[0], 1))!.stage.id).toBe("call");
    expect(currentStage(plotBible(PLOT_PATTERNS[0], PLOT_ARCS[0], 2))!.stage.id).toBe("early_success");
    expect(currentStage(plotBible(PLOT_PATTERNS[0], PLOT_ARCS[0], 8))!.stage.id).toBe("final_confrontation");
  });
  it("builds the pacing block: stage, next stage, tension, difficulty, trend", () => {
    const p = pacingBlock(plotBible("tragedy", "rise_fall", 2))!;
    expect(p).toMatchObject({
      pattern: "tragedy", arc: "rise_fall", stageIndex: 1, stageCount: 5, finished: false,
      tension: PLOTS.patterns.tragedy.stages[1]!.tension, difficulty: PLOTS.patterns.tragedy.stages[1]!.difficulty, trend: "up",
    });
    expect(p.stage.id).toBe("dream");
    expect(p.next!.id).toBe("frustration");
    expect(p.openMilestones).toBe(2);
  });
  it("marks the plot finished when every milestone is done", () => {
    const p = pacingBlock(plotBible("tragedy", "rise_fall", 10))!;
    expect(p.finished).toBe(true);
    expect(p.stage.id).toBe("downfall");
    expect(p.next).toBeNull();
  });
});
