/** Story structure: plot patterns, emotional arcs and pacing. Pure; all numbers live in data/plots.json. */
import type { Act, Plot, PlotArc, PlotPattern, PlotStage, StoryBible } from "@aedm/schemas";
import { PLOT_PATTERNS } from "@aedm/schemas";
import { PLOTS, type PlotStageData } from "./data.ts";
import { createRng } from "./rng.ts";

export type Trend = "up" | "down" | "steady";

export interface PlotOutlineStage extends PlotStageData {
  /** Party fortune (0 to 10) at the end of the stage. */
  fortune: number;
  /** How the party's fortune moves during the stage. */
  trend: Trend;
}

const TREND_TEXT: Record<Trend, string> = {
  up: "this stretch should leave the party better off",
  down: "this stretch should leave the party worse off",
  steady: "this stretch should leave the party about where it started",
};

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h | 0;
}

/**
 * Resolves the room's pattern and arc settings. "auto" (or missing) picks deterministically: the pattern from
 * the pitch keywords (ties and no match broken by the seeded RNG), the arc from the pattern's recommended arcs.
 */
export function pickPlot(opts: { pattern?: PlotPattern | "auto" | undefined; arc?: PlotArc | "auto" | undefined; pitch: string; seed: number }): { pattern: PlotPattern; arc: PlotArc } {
  const rng = createRng((opts.seed | 0) ^ fnv1a(opts.pitch.toLowerCase()));
  let pattern: PlotPattern;
  if (opts.pattern && opts.pattern !== "auto") pattern = opts.pattern;
  else {
    const pitch = opts.pitch.toLowerCase();
    const scores = PLOT_PATTERNS.map((p) => ({ p, n: PLOTS.patterns[p].keywords.filter((k) => pitch.includes(k)).length }));
    const best = Math.max(...scores.map((s) => s.n));
    pattern = rng.pick(scores.filter((s) => s.n === best).map((s) => s.p));
  }
  const arc = opts.arc && opts.arc !== "auto" ? opts.arc : rng.pick(PLOTS.patterns[pattern].recommendedArcs);
  return { pattern, arc };
}

function trendOf(arc: PlotArc, i: number): Trend {
  const f = PLOTS.arcs[arc].fortune;
  const prev = i === 0 ? PLOTS.fortune.start : (f[i - 1] as number);
  const d = (f[i] as number) - prev;
  return d > 0 ? "up" : d < 0 ? "down" : "steady";
}

/** The pattern's stages with the arc's fortune and trend per stage. */
export function plotOutline(pattern: PlotPattern, arc: PlotArc): PlotOutlineStage[] {
  return PLOTS.patterns[pattern].stages.map((s, i) => ({ ...s, fortune: PLOTS.arcs[arc].fortune[i] as number, trend: trendOf(arc, i) }));
}

/** A plot with the stage purposes as placeholder goals (the offline fallback; the model writes real goals). */
export function buildPlot(pattern: PlotPattern, arc: PlotArc, goals: Record<string, string> = {}): Plot {
  return {
    pattern, arc,
    stages: PLOTS.patterns[pattern].stages.map((s) => ({ id: s.id, title: s.name, goal: goals[s.id] ?? s.purpose })),
  };
}

/** Semantic checks for a bible's plot. Returns reasons; empty when fine or when the bible has no plot (older saves). */
export function validateBiblePlot(bible: StoryBible): string[] {
  const plot = bible.plot;
  if (!plot) return [];
  const errs: string[] = [];
  const want = PLOTS.patterns[plot.pattern].stages.map((s) => s.id);
  const got = plot.stages.map((s) => s.id);
  if (want.join() !== got.join()) errs.push(`plot.stages: stage ids must be exactly ${want.join(", ")} in that order (pattern ${plot.pattern})`);
  let last = -1;
  let ordered = true;
  const seen = new Set<string>();
  for (const m of bible.milestones) {
    if (m.stage === undefined) { errs.push(`milestone ${m.id} has no stage`); continue; }
    const idx = got.indexOf(m.stage);
    if (idx < 0) { errs.push(`milestone ${m.id} names unknown stage ${m.stage}`); continue; }
    seen.add(m.stage);
    if (idx < last) ordered = false;
    last = Math.max(last, idx);
  }
  if (!ordered) errs.push("milestones must be listed in stage order");
  for (const id of got) if (!seen.has(id)) errs.push(`stage ${id} has no milestone`);
  return errs;
}

export interface CurrentStage {
  index: number;
  stage: PlotStage;
  data: PlotStageData;
  /** True when every milestone is complete (the stage is then the last one). */
  finished: boolean;
}

/** The stage of the first incomplete milestone; the last stage once all are complete. Null without a plot. */
export function currentStage(bible: StoryBible): CurrentStage | null {
  const plot = bible.plot;
  if (!plot || plot.stages.length === 0) return null;
  const open = bible.milestones.find((m) => !m.completed && m.stage !== undefined && plot.stages.some((s) => s.id === m.stage));
  const index = open ? plot.stages.findIndex((s) => s.id === open.stage) : plot.stages.length - 1;
  const stage = plot.stages[index] as PlotStage;
  const data = PLOTS.patterns[plot.pattern].stages.find((s) => s.id === stage.id);
  if (!data) return null;
  return { index, stage, data, finished: !open };
}

export interface CurrentAct {
  /** Zero-based index into `bible.acts`. */
  index: number;
  count: number;
  act: Act;
}

/**
 * The bible's act the story is in: the plot's stages (or, without a plot, the milestones) are spread proportionally
 * over the acts, and a finished story is in the last act. Null when the bible has no acts.
 */
export function currentAct(bible: StoryBible): CurrentAct | null {
  const acts = bible.acts;
  if (!acts?.length) return null;
  const cur = currentStage(bible);
  const [done, total] = cur
    ? [cur.finished ? cur.index + 1 : cur.index, bible.plot!.stages.length]
    : [bible.milestones.filter((m) => m.completed).length, bible.milestones.length];
  const index = Math.min(acts.length - 1, Math.floor((done * acts.length) / Math.max(1, total)));
  return { index, count: acts.length, act: acts[index] as Act };
}

export interface PacingBlock {
  pattern: PlotPattern;
  patternName: string;
  arc: PlotArc;
  arcName: string;
  stageIndex: number;
  stageCount: number;
  finished: boolean;
  stage: { id: string; name: string; title: string; goal: string; purpose: string };
  next: { id: string; name: string; title: string; goal: string } | null;
  /** Target tension, 0 to 10. */
  tension: number;
  /** Suggested default difficulty for encounters; threat budgets still apply. */
  difficulty: PlotStageData["difficulty"];
  trend: Trend;
  trendText: string;
  openMilestones: number;
  /** The bible's current act; null when the bible has no acts. */
  act: CurrentAct | null;
}

/** What the DM context pack's pacing block shows. Null for a bible without a plot. */
export function pacingBlock(bible: StoryBible): PacingBlock | null {
  const plot = bible.plot;
  const cur = currentStage(bible);
  if (!plot || !cur) return null;
  const nextStage = plot.stages[cur.index + 1];
  const nextData = nextStage ? PLOTS.patterns[plot.pattern].stages[cur.index + 1] : undefined;
  const trend = trendOf(plot.arc, cur.index);
  return {
    pattern: plot.pattern, patternName: PLOTS.patterns[plot.pattern].name,
    arc: plot.arc, arcName: PLOTS.arcs[plot.arc].name,
    stageIndex: cur.index, stageCount: plot.stages.length, finished: cur.finished,
    stage: { id: cur.stage.id, name: cur.data.name, title: cur.stage.title, goal: cur.stage.goal, purpose: cur.data.purpose },
    next: nextStage && nextData ? { id: nextStage.id, name: nextData.name, title: nextStage.title, goal: nextStage.goal } : null,
    tension: cur.data.tension, difficulty: cur.data.difficulty, trend, trendText: TREND_TEXT[trend],
    openMilestones: bible.milestones.filter((m) => !m.completed && m.stage === cur.stage.id).length,
    act: currentAct(bible),
  };
}

