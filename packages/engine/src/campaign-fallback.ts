/**
 * The deterministic offline campaign plan: a bible with a plot but no plan (offline play, the fake model, the built-in
 * Lantern Marsh bible, or a model plan that failed validation) gets locations, cast, encounters, a key item, an ending and
 * machine-checkable milestone triggers, all derived from its plot stages, its milestones and a seed. Content pools and
 * thresholds are in data/campaign.json. Pure.
 */
import type {
  CastMember, EnemyGroup, EnemyRole, Milestone, MilestoneTrigger, PlanEncounter, PlanLocation, SettingPreset, StoryBible,
} from "@aedm/schemas";
import { SETTING_PRESETS } from "@aedm/schemas";
import { validateCampaign } from "./campaign.ts";
import { CAMPAIGN, PLOTS } from "./data.ts";
import { SETTING_PRESET_DATA, inferPreset } from "./map/index.ts";
import { createRng, hashSeed, type Rng } from "./rng.ts";

type Kind = "hub" | "wild" | "lair";

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 3).trimEnd()}...`);
const fill = (s: string, vars: Record<string, string>): string => s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");
const titleCase = (s: string): string => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
const ROLE_RANK: EnemyRole[] = ["minion", "standard", "elite", "boss"];

/** Take one at random without replacement (the pool is refilled when empty, so it never runs dry). */
function drawer<T>(rng: Rng, pool: readonly T[]): () => T {
  let left = [...pool];
  return () => {
    if (left.length === 0) left = [...pool];
    return left.splice(rng.int(0, left.length - 1), 1)[0] as T;
  };
}

function isPreset(p: string): p is SettingPreset {
  return (SETTING_PRESETS as readonly string[]).includes(p);
}

/**
 * Adds a campaign plan to a bible that has a plot: one location per stage chained in order (more side locations when the
 * plot is shorter than the data's minimum), a quest giver at the first and an ally at a middle location, one encounter
 * per later stage (a boss at the last), one key item, an ending, and a trigger for as many milestones of each stage as
 * the stage has things to point at (the rest stay `story`). Existing hints and every milestone fact are kept. A bible
 * without a plot comes back unchanged (a copy). The result passes `validateCampaign` unless a stage has more milestones
 * than the plan has triggers for and the machine-checkable share falls under the data's minimum.
 */
export function buildFallbackCampaign(bible: StoryBible, seed: number): StoryBible {
  const out = structuredClone(bible);
  const plot = out.plot;
  if (!plot || plot.stages.length === 0) return out;
  const F = CAMPAIGN.fallback;
  const rng = createRng(hashSeed(seed, bible.title) | 0);
  const stages = plot.stages;
  const S = stages.length;
  const themeText = `${bible.title} ${bible.digest} ${bible.tone}`;

  // locations: one per stage, then side locations if the plot is short
  const kindOf = (i: number): Kind => (i === 0 && S > 1 ? "hub" : i === S - 1 || i * 100 >= S * F.lairFromPct ? "lair" : "wild");
  const seq: number[] = stages.map((_, i) => i);
  for (let e = 0; e < Math.max(0, CAMPAIGN.limits.minLocations - S); e++) {
    const at = e % S;
    seq.splice(seq.lastIndexOf(at) + 1, 0, at);
  }
  const drawPrefix = drawer(rng, F.namePrefixes);
  const prefixFor = (base: string): string => {
    let p = drawPrefix();
    for (let n = 0; n < 8 && base.toLowerCase().startsWith(`${p.toLowerCase()} `); n++) p = drawPrefix();
    return p;
  };
  const used = new Set<string>();
  const mainOf: string[] = [];
  const locations: PlanLocation[] = seq.map((stageIdx, k) => {
    const kind = kindOf(stageIdx);
    const pool = F.presets[kind].filter(isPreset);
    const fresh = pool.filter((p) => !used.has(p));
    const theme = inferPreset(themeText, pool);
    const preset = theme ?? rng.pick(fresh.length > 0 ? fresh : pool);
    used.add(preset);
    const pd = SETTING_PRESET_DATA[preset];
    const stage = stages[stageIdx]!;
    const id = `l_${k + 1}`;
    if (mainOf[stageIdx] === undefined) mainOf[stageIdx] = id;
    return {
      id,
      name: clip(`${prefixFor(pd.starter.name)} ${titleCase(pd.starter.name)}`, 40),
      summary: clip(`${stage.title}: ${stage.goal}`, 200),
      stage: stage.id,
      connects_to: k < seq.length - 1 ? [`l_${k + 2}`] : [],
      setting: { name: pd.starter.name, preset, layout: pd.layout, environment: pd.environment, mood: pd.mood },
      theme_tags: [...pd.starter.tags].slice(0, 4),
    };
  });
  const placeName = (id: string) => locations.find((l) => l.id === id)!.name;
  const itemStage = S > 1 ? Math.min(S - 1, Math.max(1, Math.floor(S / 2))) : -1;

  // cast: a quest giver at the start, an ally where the key item lies
  const drawFirst = drawer(rng, F.castFirstNames);
  const drawLast = drawer(rng, F.castLastNames);
  const castName = () => clip(`${drawFirst()} ${drawLast()}`, 40);
  const cast: CastMember[] = [
    { id: "c_hub", name: castName(), concept: fill(F.castRoles.hub.concept, { place: placeName(mainOf[0]!) }), role: F.castRoles.hub.role as CastMember["role"], location: mainOf[0]!, voice: F.castRoles.hub.voice },
  ];
  if (itemStage >= 0) {
    const at = mainOf[itemStage]!;
    cast.push({ id: "c_ally", name: castName(), concept: fill(F.castRoles.mid.concept, { place: placeName(at) }), role: F.castRoles.mid.role as CastMember["role"], location: at, voice: F.castRoles.mid.voice });
  }

  // encounters: one per stage after the first (the only one when the plot has a single stage)
  const stageData = PLOTS.patterns[plot.pattern].stages;
  const encounters: PlanEncounter[] = [];
  for (let i = S > 1 ? 1 : 0; i < S; i++) {
    const at = mainOf[i]!;
    const diff = i === S - 1 ? "final" : stageData.find((d) => d.id === stages[i]!.id)?.difficulty ?? "standard";
    const groups: EnemyGroup[] = F.groups[diff].map((g) => ({ concept: clip(fill(F.enemyConcepts[g.role], { place: placeName(at) }), 200), role: g.role, count: g.count }));
    const top = groups.reduce<EnemyRole>((best, g) => (ROLE_RANK.indexOf(g.role) > ROLE_RANK.indexOf(best) ? g.role : best), "minion");
    encounters.push({ id: `e_${i + 1}`, name: clip(`${F.encounterNames[top]} at ${placeName(at)}`, 40), location: at, stage: stages[i]!.id, groups });
  }
  const encOf = (i: number) => encounters.find((e) => e.stage === stages[i]!.id)?.id;

  const keyItems = itemStage >= 0 ? [{ id: "k_item", name: rng.pick(F.keyItemNames), location: mainOf[itemStage]! }] : [];

  // triggers: per stage, the things there are to point at, in the order a party meets them
  const rank: Record<MilestoneTrigger["type"], number> = { reach_location: 0, talk_to: 1, obtain_item: 2, defeat_encounter: 3, story: 4 };
  const candidates = (i: number): MilestoneTrigger[] => {
    const at = mainOf[i]!;
    const enc = encOf(i);
    const defeat: MilestoneTrigger[] = enc ? [{ type: "defeat_encounter", encounter: enc }] : [];
    if (S === 1) return [...defeat, { type: "talk_to", cast: "c_hub" }];
    if (i === 0) return [{ type: "talk_to", cast: "c_hub" }];
    if (i === S - 1) return [...defeat, { type: "reach_location", location: at }];
    const item: MilestoneTrigger[] = i === itemStage ? [{ type: "obtain_item", item: "k_item" }] : [];
    const ally: MilestoneTrigger[] = i === itemStage ? [{ type: "talk_to", cast: "c_ally" }] : [];
    return [...item, { type: "reach_location", location: at }, ...defeat, ...ally];
  };
  const milestones: Milestone[] = out.milestones.map((m) => ({ ...m }));
  stages.forEach((st, i) => {
    const mine = milestones.filter((m) => m.stage === st.id);
    const chosen = candidates(i).slice(0, mine.length).sort((a, b) => rank[a.type] - rank[b.type]);
    mine.forEach((m, j) => {
      const t = chosen[j];
      if (t) m.trigger = t;
      else delete m.trigger;
    });
  });

  return {
    ...out,
    locations, cast, encounters, key_items: keyItems,
    ending: {
      goal: clip(stages[S - 1]!.goal, 200),
      success: clip(fill(F.ending.success, { title: bible.title }), 200),
      failure: clip(fill(F.ending.failure, { title: bible.title }), 200),
    },
    milestones,
  };
}

export interface EnsuredCampaign {
  /** The bible to play: the original when its plan was fine or it cannot take one, else with the fallback plan. */
  bible: StoryBible;
  /** `plan`: the bible's own plan is valid; `fallback`: the offline plan was built; `none`: the bible has no plot, so no plan. */
  source: "plan" | "fallback" | "none";
  /** Why the bible's own plan was replaced (or why there is none). Empty otherwise. */
  reasons: string[];
}

/**
 * Makes sure a bible comes out with a valid campaign plan. A valid plan is kept as is (the same object); a missing or
 * invalid one is replaced by `buildFallbackCampaign(bible, seed)` (for an invalid one, `reasons` says why, so the caller can
 * try one model repair first); a bible without a plot is returned as is with `source: "none"`.
 */
export function ensureCampaignPlan(bible: StoryBible, seed: number): EnsuredCampaign {
  if (!bible.plot) return { bible, source: "none", reasons: ["the bible has no plot, so no campaign plan can be derived"] };
  const hasPlan = bible.locations !== undefined || bible.cast !== undefined || bible.encounters !== undefined || bible.key_items !== undefined || bible.ending !== undefined;
  const reasons = validateCampaign(bible);
  if (hasPlan && reasons.length === 0) return { bible, source: "plan", reasons: [] };
  return { bible: buildFallbackCampaign(bible, seed), source: "fallback", reasons };
}
