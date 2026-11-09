import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { LlmError, RefusalError } from "../errors";
import { createAnthropicProvider, toLlmError, type AnthropicLike } from "./anthropic";

function mockClient(over: { stop_reason?: string; throwWith?: unknown } = {}) {
  const calls: { params: Record<string, unknown>; options: unknown }[] = [];
  const client: AnthropicLike = {
    messages: {
      stream(params, options) {
        calls.push({ params, options });
        let cb: ((d: string) => void) | undefined;
        return {
          on(_e: "text", f: (d: string) => void) { cb = f; return this; },
          async finalMessage() {
            if (over.throwWith) throw over.throwWith;
            cb?.("Hel"); cb?.("lo");
            return {
              content: [{ type: "thinking" }, { type: "text", text: "Hello" }],
              model: String(params.model),
              stop_reason: over.stop_reason ?? "end_turn",
              usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7 },
            };
          },
        };
      },
    },
  };
  return { client, calls };
}

const req = (tier: "fast" | "standard" | "strong", purpose: "dm" | "forge" = "dm") =>
  ({ tier, purpose, system: "SYS", messages: [{ role: "user" as const, content: "hi" }] });

describe("anthropic provider", () => {
  it("builds streaming requests without forbidden sampling params and with cached system", async () => {
    const { client, calls } = mockClient();
    const p = createAnthropicProvider({ client });
    const deltas: string[] = [];
    const res = await p.complete(req("standard"), { onText: (d) => deltas.push(d) });
    const { params } = calls[0]!;
    for (const k of ["temperature", "top_p", "top_k", "thinking", "budget_tokens"]) expect(params).not.toHaveProperty(k);
    expect(JSON.stringify(params)).not.toContain("budget_tokens");
    expect(params.system).toEqual([{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }]);
    expect(params.max_tokens).toBe(4000);
    expect(params.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(params.output_config).toEqual({ effort: "low" });
    expect(deltas.join("")).toBe("Hello");
    expect(res).toMatchObject({ text: "Hello", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 7 }, stopReason: "end_turn" });
  });

  it("maps tiers to models and effort", async () => {
    const { client, calls } = mockClient();
    const p = createAnthropicProvider({ client, models: { fast: "my-fast" } });
    await p.complete(req("fast"));
    await p.complete(req("standard"));
    await p.complete(req("strong"));
    await p.complete(req("standard", "forge"));
    expect(calls.map((c) => c.params.model)).toEqual(["my-fast", "claude-sonnet-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
    expect(calls.map((c) => (c.params.output_config as { effort: string }).effort)).toEqual(["low", "low", "medium", "medium"]);
  });

  it("passes the abort signal", async () => {
    const { client, calls } = mockClient();
    const ac = new AbortController();
    await createAnthropicProvider({ client }).complete(req("fast"), { signal: ac.signal });
    expect(calls[0]!.options).toEqual({ signal: ac.signal });
  });

  it("surfaces refusals as a typed, non-retryable error", async () => {
    const { client } = mockClient({ stop_reason: "refusal" });
    const err = await createAnthropicProvider({ client }).complete(req("fast")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefusalError);
    expect((err as LlmError).retryable).toBe(false);
  });

  it("wraps SDK errors with a retryable flag", async () => {
    const rate = new Anthropic.RateLimitError(429, undefined, "slow down", new Headers());
    const bad = new Anthropic.BadRequestError(400, undefined, "nope", new Headers());
    const srv = new Anthropic.InternalServerError(500, undefined, "boom", new Headers());
    expect(toLlmError(rate)).toMatchObject({ kind: "rate_limit", retryable: true, status: 429 });
    expect(toLlmError(bad)).toMatchObject({ kind: "api", retryable: false, status: 400 });
    expect(toLlmError(srv)).toMatchObject({ kind: "api", retryable: true });
    const { client } = mockClient({ throwWith: rate });
    await expect(createAnthropicProvider({ client }).complete(req("fast"))).rejects.toMatchObject({ name: "LlmError", retryable: true });
  });
});
