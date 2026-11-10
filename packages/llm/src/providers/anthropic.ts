import Anthropic from "@anthropic-ai/sdk";
import { LlmError, RefusalError } from "../errors";
import type { ModelProvider, ModelRequest, ModelResponse, Tier } from "../provider";

export const DEFAULT_MODELS: Record<Tier, string> = {
  fast: "claude-haiku-5-5",
  standard: "claude-sonnet-5-5",
  strong: "claude-opus-5-5",
};

/** The slice of the SDK this provider uses; tests inject a mock with this shape. */
export interface AnthropicLike {
  messages: {
    stream(
      params: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): {
      on(event: "text", cb: (delta: string, snapshot?: string) => void): unknown;
      finalMessage(): Promise<{
        content: { type: string; text?: string }[];
        model: string;
        stop_reason: string | null;
        usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null };
      }>;
    };
  };
}

export interface AnthropicProviderOptions {
  /** Defaults to ANTHROPIC_API_KEY from the environment (the SDK reads it). Never logged. */
  apiKey?: string;
  models?: Partial<Record<Tier, string>>;
  /** Injected for tests. */
  client?: AnthropicLike;
}

type Effort = "low" | "medium";

/** DM turns stay snappy; creative one-shot builders get a little more thought on the strong/standard tiers. */
export function effortFor(req: Pick<ModelRequest, "tier" | "purpose">): Effort {
  if (req.purpose === "dm" || req.purpose === "repair") return req.tier === "strong" ? "medium" : "low";
  return req.tier === "fast" ? "low" : "medium";
}

export function buildAnthropicParams(req: ModelRequest, model: string): Record<string, unknown> {
  // Deliberately absent: temperature, top_p, top_k, budget_tokens, thinking {type:"disabled"} (all 400 on these models).
  return {
    model,
    max_tokens: req.maxTokens ?? 4000,
    system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    output_config: { effort: effortFor(req) },
  };
}

export function toLlmError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new LlmError("Request aborted", "aborted", false, { cause: err });
  if (err instanceof Anthropic.RateLimitError) {
    return new LlmError("Model provider rate limit reached", "rate_limit", true, { status: 429, cause: err });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new LlmError("Could not reach the model provider", "network", true, { cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === "number" ? err.status : undefined;
    const retryable = status === undefined || status >= 500 || status === 408 || status === 409 || status === 429;
    return new LlmError(`Model provider error${status ? ` (${status})` : ""}: ${err.message}`, "api", retryable, {
      ...(status !== undefined ? { status } : {}),
      cause: err,
    });
  }
  if (err instanceof Error && err.name === "AbortError") return new LlmError("Request aborted", "aborted", false, { cause: err });
  return new LlmError(err instanceof Error ? err.message : "Unknown model error", "api", false, { cause: err });
}

export function createAnthropicProvider(options: AnthropicProviderOptions = {}): ModelProvider {
  const models = { ...DEFAULT_MODELS, ...options.models };
  let client = options.client;
  const getClient = (): AnthropicLike => {
    client ??= new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {}) as unknown as AnthropicLike;
    return client;
  };

  return {
    name: "anthropic",
    async complete(req, opts = {}): Promise<ModelResponse> {
      const model = models[req.tier];
      try {
        const stream = getClient().messages.stream(buildAnthropicParams(req, model), opts.signal ? { signal: opts.signal } : undefined);
        if (opts.onText) {
          const onText = opts.onText;
          stream.on("text", (delta) => onText(delta));
        }
        const msg = await stream.finalMessage();
        if (msg.stop_reason === "refusal") throw new RefusalError();
        const text = msg.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
        return {
          text,
          model: msg.model,
          ...(msg.usage
            ? {
                usage: {
                  inputTokens: msg.usage.input_tokens,
                  outputTokens: msg.usage.output_tokens,
                  ...(msg.usage.cache_read_input_tokens ? { cacheReadTokens: msg.usage.cache_read_input_tokens } : {}),
                },
              }
            : {}),
          ...(msg.stop_reason ? { stopReason: msg.stop_reason } : {}),
        };
      } catch (err) {
        throw toLlmError(err);
      }
    },
  };
}
