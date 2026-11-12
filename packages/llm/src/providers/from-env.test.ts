import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderFromEnv } from "./from-env";

describe("createProviderFromEnv", () => {
  it("defaults to the offline fake", () => {
    expect(createProviderFromEnv({}).name).toBe("fake");
    expect(createProviderFromEnv({ AEDM_LLM_PROVIDER: "" }).name).toBe("fake");
  });
  it("builds gemini and anthropic when their keys are set, case-insensitively", () => {
    expect(createProviderFromEnv({ AEDM_LLM_PROVIDER: "Gemini", GEMINI_API_KEY: "k" }).name).toBe("gemini");
    expect(createProviderFromEnv({ AEDM_LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" }).name).toBe("anthropic");
  });
  it("explains a missing key without echoing any key", () => {
    expect(() => createProviderFromEnv({ AEDM_LLM_PROVIDER: "gemini" })).toThrow(/GEMINI_API_KEY/);
    expect(() => createProviderFromEnv({ AEDM_LLM_PROVIDER: "anthropic" })).toThrow(/ANTHROPIC_API_KEY/);
  });
  it("rejects an unknown provider", () => {
    expect(() => createProviderFromEnv({ AEDM_LLM_PROVIDER: "nope", GEMINI_API_KEY: "SECRET" })).toThrow(/Unknown AEDM_LLM_PROVIDER "nope"/);
  });
  describe("AEDM_GEMINI_THINKING", () => {
    afterEach(() => vi.unstubAllGlobals());
    const base = { AEDM_LLM_PROVIDER: "gemini", GEMINI_API_KEY: "k" };
    it("accepts a level or off, and unset", () => {
      for (const v of [undefined, "", "minimal", "low", "medium", "high", "off"]) {
        expect(createProviderFromEnv({ ...base, AEDM_GEMINI_THINKING: v }).name).toBe("gemini");
      }
    });
    it("rejects anything else", () => {
      expect(() => createProviderFromEnv({ ...base, AEDM_GEMINI_THINKING: "max" })).toThrow(/AEDM_GEMINI_THINKING/);
    });
    it("reaches the request body", async () => {
      const seen: string[] = [];
      vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => { seen.push(init.body as string); return new Response("", { status: 500 }); });
      const run = async (v: string) => {
        const provider = createProviderFromEnv({ ...base, AEDM_GEMINI_THINKING: v });
        await provider.complete({ tier: "standard", purpose: "dm", system: "s", messages: [{ role: "user", content: "h" }] }).catch(() => undefined);
      };
      await run("high");
      await run("off");
      expect(seen[0]).toContain('"thinkingLevel":"high"');
      expect(seen[1]).not.toContain("thinkingConfig");
    });
  });
});
