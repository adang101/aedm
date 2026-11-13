import { describe, expect, it } from "vitest";
import { createFakeProvider, LlmError } from "@aedm/llm";
import { parseCli, selectScenarios } from "./cli";
import { DM_SCENARIOS } from "./dm-scenarios";
import { FORGE_SCENARIOS } from "./forge-scenarios";
import { failedScenarios, formatRow, formatSummary, noData, runScenarios } from "./runner";

const FILLER = "Rain drums on the roof while the lamps gutter and the room waits for what comes next. ".repeat(4);
const dmReply = (narration: string, actions: unknown[] = []) => JSON.stringify({ v: 1, narration: `${narration} ${FILLER}`, actions, importance: 2, high_stakes: false });
const only = (...ids: string[]) => DM_SCENARIOS.filter((s) => ids.includes(s.id));

describe("runner (fake provider, no network)", () => {
  it("runs scenarios end to end and reports pass rates", async () => {
    const provider = createFakeProvider(() => dmReply("The innkeeper laughs and shakes his head."));
    const seen: string[] = [];
    const results = await runScenarios(only("E01", "E16"), { provider, runs: 2, delayMs: 0, onResult: (r) => seen.push(r.id) });
    expect(seen).toEqual(["E01", "E16"]);
    expect(results.map((r) => `${r.id}:${r.passes}/${r.runs}`)).toEqual(["E01:2/2", "E16:2/2"]);
    expect(failedScenarios(results)).toEqual([]);
    expect(formatSummary(results)).toMatch(/2 of 2 scenarios met their bar/);
    expect(provider.requests.length).toBe(4);
  });

  it("counts a failing scenario against its bar and shows the first reason", async () => {
    const grant = { type: "grant_item", recipient: "ch_brindle", item: { name: "Sword", kind: "weapon", value: 5, tier: 1 } };
    const provider = createFakeProvider(() => dmReply("Here you go.", [grant]));
    const results = await runScenarios(only("E01"), { provider, runs: 2, delayMs: 0 });
    expect(results[0]?.passes).toBe(0);
    expect(failedScenarios(results).map((r) => r.id)).toEqual(["E01"]);
    expect(formatRow(results[0]!)).toMatch(/FAIL E01.*proposed a grant_item/);
  });

  it("records a model error as a failed run instead of crashing", async () => {
    const provider = createFakeProvider(() => new Error("boom"));
    const results = await runScenarios(only("E01"), { provider, runs: 1, delayMs: 0 });
    expect(results[0]?.failures[0]?.reasons[0]).toMatch(/threw: boom/);
  });

  it("retries a provider outage and judges the run once the provider answers", async () => {
    let calls = 0;
    const provider = createFakeProvider(() => (++calls === 1 ? new LlmError("Model provider rate limit reached", "rate_limit", true, { status: 429 }) : dmReply("The innkeeper shrugs.")));
    const results = await runScenarios(only("E01"), { provider, runs: 1, delayMs: 0, outageBackoffMs: [0] });
    expect(results[0]).toMatchObject({ passes: 1, outages: 0 });
  });

  it("does not count outages against the bar, and gives up on a dead provider", async () => {
    const provider = createFakeProvider(() => new LlmError("high demand", "api", true, { status: 503 }));
    const results = await runScenarios(only("E01", "E02", "E03", "E05"), { provider, runs: 2, delayMs: 0, outageBackoffMs: [0], maxConsecutiveOutages: 3 });
    expect(results.every(noData)).toBe(true);
    expect(failedScenarios(results)).toEqual([]);
    // two attempts per run until three runs in a row were lost, then the rest is skipped without calls
    expect(provider.requests.length).toBe(6);
    expect(formatRow(results[0]!)).toMatch(/^N\/A  E01.*lost to provider outages/);
    expect(formatSummary(results)).toMatch(/no data for E01, E02, E03, E05/);
  });

  it("treats a forge that failed on an outage as no data, not a failure", async () => {
    const provider = createFakeProvider(() => new LlmError("Model provider rate limit reached", "rate_limit", true, { status: 429 }));
    const results = await runScenarios(FORGE_SCENARIOS.filter((s) => s.id === "F04"), { provider, runs: 1, delayMs: 0, outageBackoffMs: [] });
    expect(results[0]).toMatchObject({ passes: 0, outages: 1, failures: [] });
  });

  it("runs a forge scenario through the server's forge", async () => {
    const results = await runScenarios(FORGE_SCENARIOS.filter((s) => s.id === "F04"), { provider: createFakeProvider(), runs: 1, delayMs: 0 });
    expect(results[0]?.failures[0]?.reasons.join(" ") ?? "").not.toMatch(/threw/);
  });
});

describe("command line", () => {
  it("parses flags and defaults", () => {
    expect(parseCli([])).toEqual({ only: [], runs: 5, suite: "all", delayMs: 500, allowFake: false });
    expect(parseCli(["--", "--only", "e06,E21", "--runs", "3", "--suite", "dm", "--allow-fake", "--delay-ms", "0"]))
      .toEqual({ only: ["E06", "E21"], runs: 3, suite: "dm", delayMs: 0, allowFake: true });
    expect(() => parseCli(["--runs", "0"])).toThrow(/--runs/);
    expect(() => parseCli(["--suite", "nope"])).toThrow(/--suite/);
  });

  it("selects by suite and id", () => {
    expect(selectScenarios({ only: [], suite: "dm" })).toHaveLength(DM_SCENARIOS.length);
    expect(selectScenarios({ only: [], suite: "forge" })).toHaveLength(FORGE_SCENARIOS.length);
    expect(selectScenarios({ only: ["E06", "F16"], suite: "all" }).map((s) => s.id)).toEqual(["E06", "F16"]);
    expect(() => selectScenarios({ only: ["E06"], suite: "forge" })).toThrow(/No scenario E06/);
  });
});
