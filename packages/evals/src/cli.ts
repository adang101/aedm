import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createProviderFromEnv } from "@aedm/llm";
import { DM_SCENARIOS } from "./dm-scenarios";
import { FORGE_SCENARIOS } from "./forge-scenarios";
import { DEFAULT_RUNS, failedScenarios, formatRow, formatSummary, noData, runScenarios, type ScenarioResult } from "./runner";
import type { Scenario } from "./types";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");

export const SUITES = ["dm", "forge", "all"] as const;
type Suite = (typeof SUITES)[number];

export interface CliOptions {
  only: string[];
  runs: number;
  suite: Suite;
  delayMs: number;
  allowFake: boolean;
}

/** Parses `--only E06,E21 --runs 3 --suite dm|forge|all --delay-ms 500 --allow-fake`. Throws a plain-language Error on bad input. */
export function parseCli(argv: readonly string[]): CliOptions {
  // `pnpm eval -- --only X` may hand us the separator itself
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const { values } = parseArgs({
    args,
    options: {
      only: { type: "string" }, runs: { type: "string" }, suite: { type: "string" },
      "delay-ms": { type: "string" }, "allow-fake": { type: "boolean" },
    },
  });
  const runs = values.runs === undefined ? DEFAULT_RUNS : Number(values.runs);
  const delayMs = values["delay-ms"] === undefined ? 500 : Number(values["delay-ms"]);
  const suite = values.suite ?? "all";
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs needs a whole number of 1 or more, got "${values.runs}".`);
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error(`--delay-ms needs a number of 0 or more, got "${values["delay-ms"]}".`);
  if (!(SUITES as readonly string[]).includes(suite)) throw new Error(`--suite must be ${SUITES.join(", ")}, got "${suite}".`);
  return {
    only: (values.only ?? "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean),
    runs, delayMs, suite: suite as Suite, allowFake: values["allow-fake"] ?? false,
  };
}

/** The scenarios of the suite, narrowed to `only` ids when given. Unknown ids are an error. */
export function selectScenarios(opts: Pick<CliOptions, "only" | "suite">): Scenario[] {
  const pool: Scenario[] = [...(opts.suite === "forge" ? [] : DM_SCENARIOS), ...(opts.suite === "dm" ? [] : FORGE_SCENARIOS)];
  if (opts.only.length === 0) return pool;
  const unknown = opts.only.filter((id) => !pool.some((s) => s.id === id));
  if (unknown.length) throw new Error(`No scenario ${unknown.join(", ")} in suite "${opts.suite}". Known: ${pool.map((s) => s.id).join(", ")}.`);
  return pool.filter((s) => opts.only.includes(s.id));
}

export interface Report {
  startedAt: string;
  provider: string;
  runsPerScenario: number;
  summary: string;
  results: ScenarioResult[];
}

function writeReport(report: Report): string {
  const dir = join(PACKAGE_ROOT, "reports");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${report.startedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

async function main(): Promise<number> {
  let opts: CliOptions;
  let scenarios: Scenario[];
  try {
    opts = parseCli(process.argv.slice(2));
    scenarios = selectScenarios(opts);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  try {
    process.loadEnvFile(join(REPO_ROOT, ".env")); // never overrides variables already set
  } catch {
    // no .env file: the environment alone decides
  }
  let provider;
  try {
    provider = createProviderFromEnv(process.env); // keys are read from the environment and never logged
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  if (provider.name === "fake" && !opts.allowFake) {
    console.error("Refusing to run evals against the fake provider. Set AEDM_LLM_PROVIDER=gemini or anthropic with its key (or pass --allow-fake to smoke-test the harness).");
    return 2;
  }

  console.log(`Running ${scenarios.length} scenario(s), ${opts.runs} run(s) each, provider ${provider.name}. This calls a real model and costs money.`);
  const startedAt = new Date().toISOString();
  const results = await runScenarios(scenarios, { provider, runs: opts.runs, delayMs: opts.delayMs, onResult: (r) => console.log(formatRow(r)) });
  const summary = formatSummary(results);
  console.log(`\n${summary}`);
  console.log(`Report: ${writeReport({ startedAt, provider: provider.name, runsPerScenario: opts.runs, summary, results })}`);
  // 1: a scenario is below its bar; 3: nothing failed, but some scenarios have no data (provider unavailable)
  return failedScenarios(results).length > 0 ? 1 : results.some(noData) ? 3 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}
