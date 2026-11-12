import { describe, expect, it } from "vitest";
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
});
