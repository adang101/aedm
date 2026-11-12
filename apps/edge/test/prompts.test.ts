import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("bundled prompts", () => {
  it("src/prompts.ts lists every file in packages/llm/prompts", () => {
    const files = readdirSync(new URL("../../../packages/llm/prompts/", import.meta.url))
      .filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
    const text = readFileSync(new URL("../src/prompts.ts", import.meta.url), "utf8");
    const listed = [...text.slice(text.indexOf("export const PROMPTS")).matchAll(/^\s+"?([a-z-]+)"?[:,]/gm)].map((m) => m[1] as string).sort();
    expect(listed).toEqual(files);
  });
});
