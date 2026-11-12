import { LlmError, RefusalError } from "../errors";
import type { ModelProvider, ModelRequest, ModelResponse, Tier } from "../provider";

/** Model names change often (previews get retired). Override per tier with GeminiProviderOptions.models or the AEDM_GEMINI_MODEL_* settings. */
export const DEFAULT_GEMINI_MODELS: Record<Tier, string> = {
  fast: "gemini-3.1-flash-lite",
  standard: "gemini-3-flash-preview",
  strong: "gemini-3-flash-preview",
};

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export interface GeminiProviderOptions {
  /** Never logged, and sent only in the x-goog-api-key header (never in the URL). */
  apiKey: string;
  models?: Partial<Record<Tier, string>>;
  /** Injected for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
  baseUrl?: string;
}

interface GeminiChunk {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number };
  promptFeedback?: { blockReason?: string };
  modelVersion?: string;
}

const REFUSAL_REASONS = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "IMAGE_SAFETY", "RECITATION"]);

export function buildGeminiBody(req: ModelRequest): Record<string, unknown> {
  return {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: req.messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    generationConfig: { maxOutputTokens: req.maxTokens ?? 4000 },
  };
}

export function toGeminiError(status: number, body: string): LlmError {
  let detail = "";
  try {
    detail = String((JSON.parse(body) as { error?: { message?: unknown } }).error?.message ?? "");
  } catch {
    /* not JSON */
  }
  detail = detail.replace(/\s+/g, " ").slice(0, 300);
  if (status === 429) return new LlmError("Model provider rate limit reached", "rate_limit", true, { status });
  const retryable = status >= 500 || status === 408;
  return new LlmError(`Model provider error (${status})${detail ? `: ${detail}` : ""}`, "api", retryable, { status });
}

/** Reads a server-sent-events body and yields each `data:` payload as parsed JSON. */
async function* sseChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<GeminiChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const emit = function* (block: string): Generator<GeminiChunk> {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    try {
      yield JSON.parse(data) as GeminiChunk;
    } catch {
      throw new LlmError("The model provider sent a malformed stream", "api", true);
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let m: RegExpExecArray | null;
      while ((m = /\r?\n\r?\n/.exec(buf))) {
        const block = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        yield* emit(block);
      }
    }
    buf += decoder.decode();
    if (buf.trim()) yield* emit(buf);
  } finally {
    reader.releaseLock();
  }
}

export function createGeminiProvider(options: GeminiProviderOptions): ModelProvider {
  const models = { ...DEFAULT_GEMINI_MODELS, ...options.models };
  const doFetch = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? BASE_URL;
  if (!options.apiKey) throw new Error("createGeminiProvider needs an apiKey");

  return {
    name: "gemini",
    async complete(req, opts = {}): Promise<ModelResponse> {
      const model = models[req.tier];
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": options.apiKey },
          body: JSON.stringify(buildGeminiBody(req)),
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw new LlmError("Request aborted", "aborted", false, { cause: err });
        throw new LlmError("Could not reach the model provider", "network", true, { cause: err });
      }
      if (!res.ok) throw toGeminiError(res.status, await res.text().catch(() => ""));
      if (!res.body) throw new LlmError("The model provider sent an empty response", "api", true);

      let text = "";
      let finish: string | undefined;
      let usage: GeminiChunk["usageMetadata"];
      let served = model;
      try {
        for await (const chunk of sseChunks(res.body)) {
          if (chunk.promptFeedback?.blockReason) throw new RefusalError();
          if (chunk.modelVersion) served = chunk.modelVersion;
          if (chunk.usageMetadata) usage = chunk.usageMetadata;
          const cand = chunk.candidates?.[0];
          for (const part of cand?.content?.parts ?? []) {
            if (part.thought || !part.text) continue;
            text += part.text;
            opts.onText?.(part.text);
          }
          if (cand?.finishReason) finish = cand.finishReason;
        }
      } catch (err) {
        if (err instanceof LlmError) throw err;
        if (err instanceof Error && err.name === "AbortError") throw new LlmError("Request aborted", "aborted", false, { cause: err });
        throw new LlmError("The model provider connection dropped", "network", true, { cause: err });
      }
      if (finish && REFUSAL_REASONS.has(finish) && text === "") throw new RefusalError();
      return {
        text,
        model: served,
        ...(usage
          ? {
              usage: {
                inputTokens: usage.promptTokenCount ?? 0,
                outputTokens: usage.candidatesTokenCount ?? 0,
                ...(usage.cachedContentTokenCount ? { cacheReadTokens: usage.cachedContentTokenCount } : {}),
              },
            }
          : {}),
        ...(finish ? { stopReason: finish } : {}),
      };
    },
  };
}
