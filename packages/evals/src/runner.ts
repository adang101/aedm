import {
  applyDmActions, clampEnemy, enemyRangesForLevel, registerArchetype, rngFromState, type DmContext, type GameState,
} from "@aedm/engine";
import { buildEnemy, LlmError, runDmTurn, type DmTurnResult, type ModelProvider } from "@aedm/llm";
import { fixtures, type CharacterCreate, type DmAction } from "@aedm/schemas";
import { ForgeError, forgeCharacterAbilities } from "@aedm/server/src/forge";
import type { CheckResult, DmOutcome, DmScenario, DmSetup, ForgeScenario, Scenario } from "./types";

export const DEFAULT_RUNS = 5;

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

function dmContext(setup: DmSetup): DmContext {
  return { presentCharacterIds: setup.pack.party.filter((p) => p.present).map((p) => p.id), partyLevel: setup.pack.partyLevel };
}

/** Pure: run the DM's parsed actions through the engine, from `base` (the setup's state unless enemies were registered). */
export function settleDm(setup: DmSetup, turn: Pick<DmTurnResult, "response"> & Partial<Pick<DmTurnResult, "repaired" | "salvaged">>, base: GameState = setup.state): DmOutcome {
  const proposed = turn.response.actions;
  const r = applyDmActions(base, rngFromState(base), proposed, dmContext(setup));
  return {
    before: base, state: r.state, response: turn.response, proposed, accepted: r.applied, rejected: r.rejected,
    repaired: turn.repaired ?? false, salvaged: turn.salvaged ?? false,
  };
}

/** Builds the enemies the DM named with `create_enemy` (and a `ref`) and registers them, so `spawn_entity` can use them. */
async function withEnemies(provider: ModelProvider, setup: DmSetup, actions: DmAction[]): Promise<GameState> {
  const { partyLevel } = setup.pack;
  const concepts = applyDmActions(setup.state, rngFromState(setup.state), actions, dmContext(setup)).enemyConcepts;
  let state = setup.state;
  for (const c of concepts) {
    if (!c.ref) continue;
    const r = enemyRangesForLevel(partyLevel, c.role);
    const built = await buildEnemy(
      provider,
      {
        concept: c.concept, role: c.role, settingNotes: c.setting_notes, partyLevel,
        ranges: {
          hp: [r.hp.min, r.hp.max], defense: [r.defense.min, r.defense.max], attackBonus: [r.attack.min, r.attack.max],
          damagePerRound: [r.damageHundredths.min / 100, r.damageHundredths.max / 100],
        },
      },
      {
        finalize: (draft) => {
          try {
            const x = clampEnemy(draft, partyLevel);
            return { ok: true as const, enemy: x.enemy, notes: x.notes };
          } catch (err) {
            return { ok: false as const, errors: [err instanceof Error ? err.message : "invalid enemy"] };
          }
        },
      },
    );
    const reg = registerArchetype(state, { ...built.enemy, id: c.ref }, partyLevel);
    if (reg.ok) state = reg.state;
  }
  return state;
}

async function playDm(provider: ModelProvider, s: DmScenario): Promise<CheckResult> {
  const setup = s.setup();
  const turn = await runDmTurn(provider, setup.pack);
  const base = setup.buildEnemies ? await withEnemies(provider, setup, turn.response.actions) : setup.state;
  return s.check(settleDm(setup, turn, base));
}

/** A level 1 character with only the fields the forge reads; the scores are the spike party's. */
function createFor(who: ForgeScenario["who"], texts: string[]): CharacterCreate {
  return { v: 1, ...who, key_ability: "int", scores: { ...fixtures.BRINDLE.scores }, trait_tags: ["explosives", "crafting"], ability_texts: texts };
}

/** The provider was unavailable (rate limit, network, server error): says nothing about the prompts. */
class ProviderOutage extends Error {}

/** True for errors that come from the provider being unavailable, not from what the model wrote. */
export function isOutage(err: unknown): boolean {
  return err instanceof LlmError && (err.kind === "rate_limit" || err.kind === "network" || (err.kind === "api" && (err.status ?? 0) >= 500));
}

async function playForge(provider: ModelProvider, s: ForgeScenario): Promise<CheckResult> {
  let lastModelError: unknown;
  try {
    const outcome = await forgeCharacterAbilities(provider, createFor(s.who, s.texts), {
      ...(s.context ? { context: s.context } : {}),
      sleep, retryBackoffMs: 1000,
      onModelError: (err) => { lastModelError = err; },
    });
    return s.check(outcome);
  } catch (err) {
    // the forge wraps model errors in a player-facing ForgeError; the model error says whether it was an outage
    if (err instanceof ForgeError && isOutage(lastModelError)) throw new ProviderOutage((lastModelError as Error).message);
    throw err;
  }
}

/** One run's outcome: a checked result, or a provider outage (no data). */
export type RunOutcome = CheckResult | { outage: string };

/** One run. A provider outage is reported as such; anything else thrown is a failed run, not a crash. */
export async function runOnce(provider: ModelProvider, s: Scenario): Promise<RunOutcome> {
  try {
    return s.kind === "dm" ? await playDm(provider, s) : await playForge(provider, s);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof ProviderOutage || isOutage(err)) return { outage: message };
    return { pass: false, reasons: [`threw: ${message}`] };
  }
}

export interface ScenarioResult {
  id: string;
  kind: Scenario["kind"];
  category: string;
  description: string;
  threshold: number;
  runs: number;
  passes: number;
  failures: { run: number; reasons: string[] }[];
  /** Runs lost to provider outages (after retries) or skipped once the provider was given up on. They do not count against the bar. */
  outages: number;
  notes: string[];
}

export interface RunOptions {
  provider: ModelProvider;
  runs: number;
  /** Pause between model runs, to respect rate limits. */
  delayMs: number;
  /** Waits before retrying a run lost to a provider outage; one retry per entry. Default 15 s, then 45 s. */
  outageBackoffMs?: readonly number[];
  /** Consecutive outage runs (after retries) before the provider is given up on and the remaining runs are skipped. Default 3. */
  maxConsecutiveOutages?: number;
  onResult?: (r: ScenarioResult) => void;
}

/** Runs every scenario `runs` times, one run at a time. Outages are retried with backoff and never count as failures. */
export async function runScenarios(scenarios: readonly Scenario[], opts: RunOptions): Promise<ScenarioResult[]> {
  const backoff = opts.outageBackoffMs ?? [15_000, 45_000];
  const maxOutages = opts.maxConsecutiveOutages ?? 3;
  const results: ScenarioResult[] = [];
  let first = true;
  let outageStreak = 0;
  for (const s of scenarios) {
    const failures: ScenarioResult["failures"] = [];
    const notes = new Set<string>();
    let passes = 0;
    let outages = 0;
    for (let run = 1; run <= opts.runs; run++) {
      if (outageStreak >= maxOutages) { outages++; continue; }
      if (!first) await sleep(opts.delayMs);
      first = false;
      let r = await runOnce(opts.provider, s);
      for (let i = 0; "outage" in r && i < backoff.length; i++) {
        await sleep(backoff[i] as number);
        r = await runOnce(opts.provider, s);
      }
      if ("outage" in r) {
        outages++;
        outageStreak++;
        notes.add(`provider unavailable: ${r.outage}`);
        continue;
      }
      outageStreak = 0;
      if (r.pass) passes++;
      else failures.push({ run, reasons: r.reasons });
      for (const n of r.notes ?? []) notes.add(n);
    }
    const result: ScenarioResult = {
      id: s.id, kind: s.kind, category: s.category, description: s.description, threshold: s.threshold,
      runs: opts.runs, passes, failures, outages, notes: [...notes],
    };
    results.push(result);
    opts.onResult?.(result);
  }
  return results;
}

/** Runs that reached a verdict. */
const judged = (r: ScenarioResult): number => r.runs - r.outages;

/** No run reached a verdict: the provider was unavailable throughout. */
export const noData = (r: ScenarioResult): boolean => judged(r) === 0;

export const meetsThreshold = (r: ScenarioResult): boolean => !noData(r) && r.passes / judged(r) >= r.threshold - 1e-9;

/** Scenarios below their bar on the runs that reached a verdict. Scenarios with no data are not failures. */
export const failedScenarios = (results: readonly ScenarioResult[]): ScenarioResult[] => results.filter((r) => !noData(r) && !meetsThreshold(r));

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** One table row: pass count, whether the bar was met, and the first failure's reasons. */
export function formatRow(r: ScenarioResult): string {
  const why = r.failures[0] ? ` | run ${r.failures[0].run}: ${r.failures[0].reasons.join("; ")}` : "";
  const status = noData(r) ? "N/A " : meetsThreshold(r) ? "ok  " : "FAIL";
  const lost = r.outages ? ` [${r.outages} lost to provider outages]` : "";
  return `${status} ${r.id.padEnd(4)} ${`${r.passes}/${judged(r)}`.padEnd(5)} (bar ${pct(r.threshold)}) ${r.description}${lost}${why}`;
}

export function formatSummary(results: readonly ScenarioResult[]): string {
  const bad = failedScenarios(results);
  const empty = results.filter(noData);
  const total = results.reduce((n, r) => n + judged(r), 0);
  const passed = results.reduce((n, r) => n + r.passes, 0);
  const lost = results.reduce((n, r) => n + r.outages, 0);
  return [
    `${results.length - bad.length - empty.length} of ${results.length} scenarios met their bar; ${passed} of ${total} judged runs passed.`,
    ...(bad.length ? [`Below the bar: ${bad.map((r) => r.id).join(", ")}`] : []),
    ...(lost ? [`${lost} run(s) lost to provider outages${empty.length ? `; no data for ${empty.map((r) => r.id).join(", ")}` : ""}.`] : []),
  ].join("\n");
}
