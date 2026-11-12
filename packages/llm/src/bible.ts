import { PLOTS, plotOutline, validateBiblePlot } from "@aedm/engine";
import { StoryBibleSchema, type PlotArc, type PlotPattern, type StoryBible } from "@aedm/schemas";
import { escapeUntrusted } from "./context";
import { lanternMarshBible } from "./default-bible";
import { completeWithRepair, type CallOptions } from "./pipeline";
import type { ModelProvider } from "./provider";
import { loadPrompt } from "./template";

export interface BibleInput {
  pitch: string;
  partyBriefs: string[];
  contentRating: string;
  /** The plot plan the engine resolved (from the room settings, or picked for "auto"). Omitted: the model chooses. */
  plot?: { pattern: PlotPattern; arc: PlotArc };
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

/** Semantic check on a generated bible (engine-owned rules). Returns the reasons it fails, or undefined. */
export function checkBible(bible: StoryBible, want?: { pattern: PlotPattern; arc: PlotArc }): string | undefined {
  const errs: string[] = [];
  if (want) {
    if (!bible.plot) errs.push("- plot: required");
    else {
      if (bible.plot.pattern !== want.pattern) errs.push(`- plot.pattern: must be ${want.pattern}`);
      if (bible.plot.arc !== want.arc) errs.push(`- plot.arc: must be ${want.arc}`);
    }
  }
  for (const e of validateBiblePlot(bible)) errs.push(`- ${e}`);
  return errs.length ? errs.join("\n") : undefined;
}

/** Generates the story bible. If parsing fails twice, returns the built-in Lantern Marsh bible. Provider errors still throw. */
export async function generateStoryBible(provider: ModelProvider, input: BibleInput, opts: CallOptions = {}): Promise<StoryBible> {
  const user = [
    `<story_pitch>\n${escapeUntrusted(input.pitch, 1500)}\n</story_pitch>`,
    `<party_briefs>\n${input.partyBriefs.map((b) => `- ${escapeUntrusted(b, 300)}`).join("\n")}\n</party_briefs>`,
    `<content_rating>${input.contentRating}</content_rating>`,
    ...(input.plot ? [plotPlanSection(input.plot)] : []),
  ].join("\n");
  const outcome = await completeWithRepair(
    provider,
    { tier: "standard", system: loadPrompt("story-bible"), messages: [{ role: "user", content: user }], purpose: "bible", maxTokens: 6000 },
    StoryBibleSchema,
    opts,
    (b) => checkBible(b, input.plot),
  );
  return outcome.ok ? outcome.data : lanternMarshBible(input.plot?.pattern, input.plot?.arc);
}
