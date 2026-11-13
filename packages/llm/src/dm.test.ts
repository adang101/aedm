import { DmResponseSchema } from "@aedm/schemas";
import { describe, expect, it } from "vitest";
import { runDmTurn } from "./dm";
import { LlmError } from "./errors";
import { MAX_OUTPUT_TOKENS } from "./provider";
import { createFakeProvider } from "./providers/fake";
import { makeLanternPack } from "./testing";

const NARRATION = Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ");
const good = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, narration: NARRATION, actions: [{ type: "suggest_actions", chips: ["Look around", "Ask someone"] }], importance: 2, high_stakes: false, ...extra });
const pack = () => makeLanternPack([{ characterId: "ch_brindle", characterName: "Brindle Ash", text: "I look around." }]);

describe("runDmTurn", () => {
  it("accepts a valid fenced reply with one call", async () => {
    const p = createFakeProvider(["Here you go:\n```json\n" + good() + "\n```"]);
    const r = await runDmTurn(p, pack());
    expect(r.repaired).toBe(false);
    expect(r.salvaged).toBe(false);
    expect(p.requests).toHaveLength(1);
    expect(p.requests[0]!.tier).toBe("standard");
    expect(p.requests[0]!.purpose).toBe("dm");
    expect(DmResponseSchema.safeParse(r.response).success).toBe(true);
  });

  it("uses the strong tier when highStakes", async () => {
    const p = createFakeProvider([good()]);
    await runDmTurn(p, pack(), { highStakes: true });
    expect(p.requests[0]!.tier).toBe("strong");
  });

  it("repairs once: the repair request carries the error lines", async () => {
    const bad = good({ importance: 9 });
    const p = createFakeProvider([bad, good()]);
    const r = await runDmTurn(p, pack());
    expect(r.repaired).toBe(true);
    expect(r.salvaged).toBe(false);
    expect(p.requests).toHaveLength(2);
    const repair = p.requests[1]!;
    expect(repair.purpose).toBe("repair");
    // minimal repair: one user message with the bad reply and the errors, not the whole DM context
    expect(repair.messages).toHaveLength(1);
    expect(repair.messages[0]!.role).toBe("user");
    expect(repair.messages[0]!.content).toContain(bad);
    expect(repair.messages[0]!.content).toMatch(/^- importance: /m);
    expect(repair.messages[0]!.content).not.toContain("<player_input");
    expect(repair.maxTokens).toBe(p.requests[0]!.maxTokens);
    expect(repair.system).toBe(p.requests[0]!.system);
  });

  it("the repair payload is a fraction of the first request", async () => {
    const big = makeLanternPack([{ characterId: "ch_brindle", characterName: "Brindle Ash", text: "I look around." }]);
    big.chapters = Array.from({ length: 4 }, (_, i) => `chapter ${i} ${"word ".repeat(120)}`);
    const p = createFakeProvider([good({ importance: 9 }), good()]);
    await runDmTurn(p, big);
    const size = (r: { messages: { content: string }[] }) => r.messages.reduce((n, m) => n + m.content.length, 0);
    expect(size(p.requests[1]!)).toBeLessThan(size(p.requests[0]!) / 3);
  });

  it("caps the output per purpose, and a caller can override the DM cap", async () => {
    const p = createFakeProvider([good(), good()]);
    await runDmTurn(p, pack());
    await runDmTurn(p, pack(), { maxTokens: 900 });
    expect(p.requests[0]!.maxTokens).toBe(MAX_OUTPUT_TOKENS.dm);
    expect(p.requests[1]!.maxTokens).toBe(900);
    for (const cap of Object.values(MAX_OUTPUT_TOKENS)) expect(cap).toBeGreaterThanOrEqual(800);
  });

  it("salvages valid actions after two bad replies, drops the rest, never makes a third call", async () => {
    const bad = JSON.stringify({
      v: 1, narration: Array.from({ length: 200 }, (_, i) => `w${i}.`.replace(".", i % 20 === 19 ? "." : "")).join(" "),
      actions: [
        { type: "grant_item", recipient: "ch_brindle", item: { name: "Sword", kind: "weapon", value: 5, extra: true } },
        { type: "request_check", target: "ch_orrin", ability: "wis", dc: 15, tags: ["perception"], advantage: "none", reason: "Listening" },
        { type: "teleport_party" },
        { type: "suggest_actions", chips: ["One"] },
      ],
      importance: "high",
    });
    const p = createFakeProvider([bad, bad]);
    const r = await runDmTurn(p, pack());
    expect(p.requests).toHaveLength(2);
    expect(r.salvaged).toBe(true);
    expect(r.response.actions.map((a) => a.type)).toEqual(["request_check"]);
    expect(r.droppedActions).toHaveLength(3);
    expect(r.droppedActions[0]!.error).toBeTruthy();
    expect(r.response.narration.split(/\s+/).length).toBeLessThanOrEqual(150);
    expect(r.response.importance).toBe(2);
  });

  it("throws a retryable LlmError when the reply has no JSON at all", async () => {
    const p = createFakeProvider(["I cannot do that.", "Still no."]);
    await expect(runDmTurn(p, pack())).rejects.toBeInstanceOf(LlmError);
    expect(p.requests).toHaveLength(2);
  });

  it("streams narration deltas while the JSON arrives", async () => {
    const doc = good({ narration: 'Fog "rolls" in.\nIt ' + NARRATION });
    const p = createFakeProvider([doc], { chunkSize: 5 });
    const deltas: string[] = [];
    const r = await runDmTurn(p, pack(), { onNarration: (d) => deltas.push(d) });
    expect(deltas.length).toBeGreaterThan(3);
    expect(deltas.join("")).toBe(r.response.narration);
    expect(r.streamedNarration).toBe(r.response.narration);
  });
});
