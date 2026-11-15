import { isMachineTrigger, triggerOf } from "@aedm/engine";
import { checkBible } from "@aedm/llm";
import type { PlotArc, PlotPattern, StoryBible } from "@aedm/schemas";
import { expect, verdict } from "./checks";
import type { BibleOutcome, BibleScenario, CheckResult } from "./types";

const SOFT = 0.8;

/**
 * Judges a first-try story bible as the engine would, then as a player would. The engine's part is the bible's own check
 * (schema, plot, and `validateCampaign`), so the reasons printed are the ones a repair call would be given. The player's
 * part is shape: a hint on every milestone, a named cast, a build-up of fights, places that differ from each other.
 */
function planChecks(o: BibleOutcome, want?: { pattern: PlotPattern; arc: PlotArc }): CheckResult {
  if (!o.bible) return { pass: false, reasons: [`not a schema-valid bible: ${(o.errors ?? "").split("\n").slice(0, 3).join(" ")}`] };
  const b: StoryBible = o.bible;
  const engine = checkBible(b, want);
  const layouts = new Set((b.locations ?? []).map((l) => `${l.setting.layout}/${l.setting.preset ?? l.setting.environment}`));
  const machine = b.milestones.filter((m) => isMachineTrigger(triggerOf(m))).length;
  const fightStages = new Set((b.encounters ?? []).map((e) => e.stage));
  return verdict([
    engine === undefined ? undefined : `the engine rejects the bible: ${engine.replace(/\n/g, " ")}`,
    expect(b.milestones.every((m) => (m.hint ?? "").trim().length >= 8), "a milestone has no usable hint"),
    expect(b.milestones.every((m) => m.hint !== m.description), "a hint just repeats the milestone's description"),
    expect((b.cast ?? []).length >= 3, `only ${(b.cast ?? []).length} cast members`),
    expect((b.encounters ?? []).length >= 3 && fightStages.size >= 3, "fewer than 3 fights, or they sit in fewer than 3 stages"),
    expect((b.key_items ?? []).length >= 1, "no key items"),
    expect(layouts.size >= 3, "the places barely differ from one another (fewer than 3 different layouts or presets)"),
    expect((b.locations ?? []).length >= (b.plot?.stages.length ?? 5), "fewer places than stages"),
  ], [`${(b.locations ?? []).length} places, ${(b.cast ?? []).length} cast, ${(b.encounters ?? []).length} fights, ${machine} of ${b.milestones.length} milestones machine-checkable`]);
}

const CONTENT_RATING = "teen";
const PARTY = ["Brindle Ash: demolitions expert with a grudge against the harbor guild", "Tamsin Quickfoot: courier who knows every back road", "Orrin Vale: marsh herbalist who hears things in the reeds"];

const B01: BibleScenario = {
  kind: "bible", id: "B01", category: "Campaign plan", threshold: SOFT,
  description: "Story bible with a plot plan: the first reply carries a valid campaign plan",
  input: {
    pitch: "A drowned coastal region where fog hides old secrets. The lighthouse keeper vanished and villagers sleepwalk into the marsh.",
    partyBriefs: PARTY, contentRating: CONTENT_RATING, plot: { pattern: "overcoming_the_monster", arc: "fall_rise" },
  },
  check: (o) => planChecks(o, { pattern: "overcoming_the_monster", arc: "fall_rise" }),
};

const B02: BibleScenario = {
  kind: "bible", id: "B02", category: "Campaign plan", threshold: SOFT,
  description: "Story bible with no plot plan (the model picks one) and another pitch: the plan is still valid",
  input: {
    pitch: "A caravan city on the back of a slow desert giant. Someone is stealing the water that keeps it walking.",
    partyBriefs: PARTY, contentRating: "family",
  },
  check: (o) => planChecks(o),
};

export const BIBLE_SCENARIOS: BibleScenario[] = [B01, B02];
