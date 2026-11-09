import { describe, expect, it } from "vitest";
import { parseEnv } from "./env";

describe("parseEnv", () => {
  it("reads KEY=VALUE lines, quotes and comments", () => {
    const env = parseEnv(`# comment\nANTHROPIC_API_KEY=\nAEDM_PORT=9000 # inline\nAEDM_LLM_PROVIDER="fake"\nexport X='y z'\n\nbad line\n`);
    expect(env).toEqual({ ANTHROPIC_API_KEY: "", AEDM_PORT: "9000", AEDM_LLM_PROVIDER: "fake", X: "y z" });
  });
});
