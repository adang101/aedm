import { describe, expect, it } from "vitest";
import { estimateRequestTokens, estimateTokens } from "./tokens";

describe("estimateTokens", () => {
  it("is zero for empty text and deterministic", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("hello world")).toBe(estimateTokens("hello world"));
  });
  it("is roughly chars/4 for prose", () => {
    const prose = "The quick brown fox jumps over the lazy dog. ".repeat(20);
    const est = estimateTokens(prose);
    expect(est).toBeGreaterThan(prose.length / 6);
    expect(est).toBeLessThan(prose.length / 3);
  });
  it("charges more per char for JSON than for prose", () => {
    const json = JSON.stringify({ a: [1, 2, 3], b: { c: "d" } });
    expect(estimateTokens(json) / json.length).toBeGreaterThan(estimateTokens("lorem ipsum dolor sit amet") / 26);
  });
  it("sums a request", () => {
    const req = { system: "abcd efgh", messages: [{ content: "ijkl" }, { content: "mnop" }] };
    expect(estimateRequestTokens(req)).toBe(estimateTokens("abcd efgh") + 2 * estimateTokens("ijkl"));
  });
});
