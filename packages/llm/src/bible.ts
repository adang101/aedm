import { PLOTS, ensureCampaignPlan, hasCampaignPlan, hashSeed, plotOutline, validateBiblePlot, validateCampaign } from "@aedm/engine";
import { StoryBibleSchema, type PlotArc, type PlotPattern, type StoryBible } from "@aedm/schemas";
import { catalogVars, escapeUntrusted } from "./context";
import { lanternMarshBible } from "./default-bible";
import { completeWithRepair, type CallOptions } from "./pipeline";
import { MAX_OUTPUT_TOKENS, type ModelProvider, type ModelRequest } from "./provider";
import { renderPrompt } from "./template";

export interface BibleInput {
  pitch: string;
  partyBriefs: string[];
  contentRating: string;
  /** The plot plan the engine resolved (from the room settings, or picked for "auto"). Omitted: the model chooses. */
  plot?: { pattern: PlotPattern; arc: PlotArc };
  /** Seeds the offline plan when the model's own plan fails twice. Omitted: derived from the pitch. */
  seed?: number;
}

const TREND_ARROW = { up: "up", down: "down", steady: "level" } as const;

/** The `<plot_plan>` section of the story bible request: the pattern's stages and the arc's fortune per stage. */
export function plotPlanSection(plot: { pattern: PlotPattern; arc: PlotArc }): string {
  const p = PLOTS.patterns[plot.pattern];
  const a = PLOTS.arcs[plot.arc];
  return [
    "<plot_plan>",
    `pattern: ${plot.pattern} (${p.name}): ${p.shape}`,
    `arc: ${plot.arc} (${a.name}): fortune curve ${a.curve}`,
    "stages, in order (use these ids exactly):",
    ...plotOutline(plot.pattern, plot.arc).map((s) =>
      `- ${s.id} | ${s.name} | ${s.purpose} | tension ${s.tension} of 10 | fortune ${TREND_ARROW[s.trend]} to ${s.fortune} of 10`),
    "</plot_plan>",
  ].join("\n");
}

/** Semantic check on the plot of a generated bible (engine-owned rules). Returns the reasons it fails, or undefined. */
export function checkBiblePlot(bible: StoryBible, want?: { pattern: PlotPattern; arc: PlotArc }): string | undefined {
  const errs: string[] = [];
  if (!bible.plot) errs.push("- plot: required");
  else if (want) {
    if (bible.plot.pattern !== want.pattern) errs.push(`- plot.pattern: must be ${want.pattern}`);
    if (bible.plot.arc !== want.arc) errs.push(`- plot.arc: must be ${want.arc}`);
  }
  for (const e of validateBiblePlot(bible)) errs.push(`- ${e}`);
  return errs.length ? errs.join("\n") : undefined;
}

/** Most plan reasons listed in a repair request (the model fixes the first ones and the rest often follow). */
const MAX_PLAN_REASONS = 12;

/** Semantic check on the campaign plan of a generated bible: it is required, then `validateCampaign` holds it. Returns the reasons, or undefined. */
export function checkBiblePlan(bible: StoryBible): string | undefined {
  const reasons = hasCampaignPlan(bible)
    ? validateCampaign(bible)
    : ["campaign plan: locations, cast, encounters, key_items and ending are required"];
  if (reasons.length === 0) return undefined;
  const shown = reasons.slice(0, MAX_PLAN_REASONS).map((r) => `- ${r}`);
  if (reasons.length > MAX_PLAN_REASONS) shown.push(`- (${reasons.length - MAX_PLAN_REASONS} more)`);
  return shown.join("\n");
}

/** Semantic check on a generated bible: the plot, then the campaign plan. Returns the reasons it fails, or undefined. */
export function checkBible(bible: StoryBible, want?: { pattern: PlotPattern; arc: PlotArc }): string | undefined {
  const parts = [checkBiblePlot(bible, want), checkBiblePlan(bible)].filter((p): p is string => p !== undefined);
  return parts.length ? parts.join("\n") : undefined;
}

/**
 * Generates the story bible, with a campaign plan the engine accepts. One repair call at most, told exactly which plot or plan
 * rules failed. If it is still invalid: a reply whose story and plot were fine keeps its story and gets the engine's offline
 * plan (`ensureCampaignPlan`); anything else becomes the built-in Lantern Marsh bible (hand-written plan). Either way the result
 * passes `validateCampaign`. Provider errors still throw.
 */
export async function generateStoryBible(provider: ModelProvider, input: BibleInput, opts: CallOptions = {}): Promise<StoryBible> {
  const seed = input.seed ?? hashSeed("bible", input.pitch);
  /** The latest reply that parsed and whose story and plot were fine; only its plan may be wrong. */
  let storyOnly: StoryBible | undefined;
  const outcome = await completeWithRepair(
    provider,
    bibleRequest(input),
    StoryBibleSchema,
    opts,
    (b) => {
      if (checkBiblePlot(b, input.plot) === undefined) storyOnly = b;
      return checkBible(b, input.plot);
    },
  );
  if (outcome.ok) return outcome.data;
  if (storyOnly) {
    const planned = ensureCampaignPlan(storyOnly, seed).bible;
    if (hasCampaignPlan(planned) && validateCampaign(planned).length === 0) return planned;
  }
  return lanternMarshBible(input.plot?.pattern, input.plot?.arc);
}

/** The story bible call: the stable system prompt and the pitch, party, rating and plot plan. */
export function bibleRequest(input: BibleInput): ModelRequest {
  const user = [
    `<story_pitch>\n${escapeUntrusted(input.pitch, 1500)}\n</story_pitch>`,
    `<party_briefs>\n${input.partyBriefs.map((b) => `- ${escapeUntrusted(b, 300)}`).join("\n")}\n</party_briefs>`,
    `<content_rating>${input.contentRating}</content_rating>`,
    ...(input.plot ? [plotPlanSection(input.plot)] : []),
  ].join("\n");
  return { tier: "standard", system: bibleSystem(), messages: [{ role: "user", content: user }], purpose: "bible", maxTokens: MAX_OUTPUT_TOKENS.bible };
}

/** The story bible system prompt with the engine's enum lists filled in. */
export function bibleSystem(): string {
  const { layouts, setting_presets } = catalogVars();
  return renderPrompt("story-bible", { layouts: layouts!, setting_presets: setting_presets! });
}
