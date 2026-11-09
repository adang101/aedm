import { readdirSync } from "node:fs";
import { DM_ACTION_TYPES, DmResponseSchema, CHECK_TAGS, CONDITIONS } from "@aedm/schemas";
import { describe, expect, it } from "vitest";
import { buildDmSystem } from "./context";
import { extractJson } from "./json";
import { loadPrompt, renderTemplate, templateKeys } from "./template";

describe("renderTemplate", () => {
  it("fills placeholders and does not re-expand inserted values", () => {
    expect(renderTemplate("a {{x}} b {{ y }}", { x: "{{y}}", y: 2 })).toBe("a {{y}} b 2");
  });
  it("throws on a missing key", () => {
    expect(() => renderTemplate("hello {{name}}", {})).toThrow(/name/);
  });
});

describe("prompt files", () => {
  it("all six prompt files exist", () => {
    const files = readdirSync(new URL("../prompts/", import.meta.url));
    for (const f of ["dm-system", "ability-forge", "enemy-builder", "repair", "story-bible", "summary"]) {
      expect(files).toContain(`${f}.md`);
    }
  });

  it("the DM system prompt renders fully and documents every action type", () => {
    const sys = buildDmSystem();
    expect(templateKeys(sys)).toEqual([]);
    for (const t of DM_ACTION_TYPES) expect(sys, t).toContain(`- ${t}: {"type":"${t}"`);
    for (const t of CHECK_TAGS) expect(sys).toContain(t);
    for (const c of CONDITIONS) expect(sys).toContain(c);
  });

  it("the example response in dm-system.md is valid", () => {
    const block = /```json\n([\s\S]*?)\n```/.exec(loadPrompt("dm-system"))?.[1];
    const parsed = DmResponseSchema.safeParse(extractJson(block ?? ""));
    expect(parsed.error?.issues).toBeUndefined();
    expect(parsed.success).toBe(true);
  });
});
