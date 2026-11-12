import { describe, expect, it } from "vitest";
import { LlmError, RefusalError } from "../errors";
import { buildGeminiBody, createGeminiProvider, toGeminiError } from "./gemini";

const req = (over: Record<string, unknown> = {}) =>
  ({ tier: "standard" as const, purpose: "dm" as const, system: "SYS", messages: [{ role: "user" as const, content: "hi" }, { role: "assistant" as const, content: "yo" }], ...over });

function sse(chunks: unknown[], split = 7): Response {
  const bytes = new TextEncoder().encode(chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join(""));
  const stream = new ReadableStream<Uint8Array>({
    start(ctl) {
      for (let i = 0; i < bytes.length; i += split) ctl.enqueue(bytes.slice(i, i + split));
      ctl.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return respond(); }) as unknown as typeof fetch;
  return { f, calls };
}

describe("gemini provider", () => {
  it("builds the request with the key in a header only, system instruction, and mapped roles", async () => {
    const { f, calls } = fakeFetch(() => sse([{ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }]));
    await createGeminiProvider({ apiKey: "SECRET-KEY", fetch: f }).complete(req());
    const { url, init } = calls[0]!;
    expect(url).toContain("/models/gemini-3-flash-preview:streamGenerateContent?alt=sse");
    expect(url).not.toContain("SECRET-KEY");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("SECRET-KEY");
    expect(JSON.parse(init.body as string)).toEqual({
      systemInstruction: { parts: [{ text: "SYS" }] },
      contents: [{ role: "user", parts: [{ text: "hi" }] }, { role: "model", parts: [{ text: "yo" }] }],
      generationConfig: { maxOutputTokens: 4000 },
    });
  });

  it("streams text deltas across chunk boundaries, skips thought parts, and reports usage", async () => {
    const { f } = fakeFetch(() => sse([
      { candidates: [{ content: { parts: [{ text: "hidden", thought: true }, { text: "Hel" }] } }] },
      { candidates: [{ content: { parts: [{ text: "lo" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, cachedContentTokenCount: 3 }, modelVersion: "gemini-x" },
    ], 5));
    const deltas: string[] = [];
    const res = await createGeminiProvider({ apiKey: "k", fetch: f }).complete(req(), { onText: (d) => deltas.push(d) });
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(res).toEqual({ text: "Hello", model: "gemini-x", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 }, stopReason: "STOP" });
  });

  it("uses per-tier model overrides", async () => {
    const { f, calls } = fakeFetch(() => sse([{ candidates: [{ content: { parts: [{ text: "ok" }] } }] }]));
    await createGeminiProvider({ apiKey: "k", fetch: f, models: { fast: "my-fast" } }).complete(req({ tier: "fast" }));
    expect(calls[0]!.url).toContain("/models/my-fast:");
  });

  it("maps blocks and safety stops to a refusal", async () => {
    const blocked = fakeFetch(() => sse([{ promptFeedback: { blockReason: "SAFETY" } }]));
    await expect(createGeminiProvider({ apiKey: "k", fetch: blocked.f }).complete(req())).rejects.toBeInstanceOf(RefusalError);
    const stopped = fakeFetch(() => sse([{ candidates: [{ finishReason: "SAFETY" }] }]));
    await expect(createGeminiProvider({ apiKey: "k", fetch: stopped.f }).complete(req())).rejects.toBeInstanceOf(RefusalError);
  });

  it("classifies HTTP errors", () => {
    expect(toGeminiError(429, "")).toMatchObject({ kind: "rate_limit", retryable: true, status: 429 });
    expect(toGeminiError(503, "")).toMatchObject({ kind: "api", retryable: true });
    const e = toGeminiError(404, JSON.stringify({ error: { message: "model gone" } }));
    expect(e).toMatchObject({ kind: "api", retryable: false, status: 404 });
    expect(e.message).toContain("model gone");
  });

  it("turns a failed request into an LlmError and never leaks the key", async () => {
    const { f } = fakeFetch(() => new Response(JSON.stringify({ error: { message: "bad" } }), { status: 400 }));
    const err = await createGeminiProvider({ apiKey: "SECRET-KEY", fetch: f }).complete(req()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(String((err as Error).message)).not.toContain("SECRET-KEY");
    const net = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await expect(createGeminiProvider({ apiKey: "k", fetch: net }).complete(req())).rejects.toMatchObject({ kind: "network", retryable: true });
  });

  it("requires a key and builds a bounded body", () => {
    expect(() => createGeminiProvider({ apiKey: "" })).toThrow(/apiKey/);
    expect((buildGeminiBody(req({ maxTokens: 99 })).generationConfig as { maxOutputTokens: number }).maxOutputTokens).toBe(99);
  });
});
