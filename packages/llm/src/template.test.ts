import { readdirSync } from "node:fs";
import { DM_ACTION_TYPES, DmResponseSchema, CHECK_TAGS, CONDITIONS, LAYOUTS, PATTERNS, SETTING_PRESETS, SpriteSpecDraftSchema } from "@aedm/schemas";
import { describe, expect, it } from "vitest";
import { buildDmSystem } from "./context";
import { buildSpriteDesignerPrompt } from "./sprite-designer";
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
  it("all prompt files exist", () => {
    const files = readdirSync(new URL("../prompts/", import.meta.url));
    for (const f of ["dm-system", "ability-forge", "enemy-builder", "repair", "story-bible", "summary", "sprite-designer"]) {
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

  it("the DM prompt lists layouts, presets, patterns and the injected material ids", () => {
    const sys = buildDmSystem();
    for (const l of LAYOUTS) expect(sys).toContain(l);
    for (const p of SETTING_PRESETS) expect(sys).toContain(p);
    for (const p of PATTERNS) expect(sys).toContain(p);
    expect(sys).toContain("stone_floor");
    expect(sys).not.toContain('"biome"');
    const custom = buildDmSystem({ materialIds: ["moon_dust", "glass_floor"] });
    expect(custom).toContain("moon_dust, glass_floor");
    expect(custom).not.toContain("stone_floor,");
    expect(templateKeys(custom)).toEqual([]);
    expect(buildDmSystem({ materialIds: ["moon_dust", "glass_floor"] })).toBe(custom);
  });

  it("the sprite designer prompt renders fully and its example is a valid draft", () => {
    const { system, user } = buildSpriteDesignerPrompt({ concept: "a robed chorister", appearance: "dripping hem <b>", role: "enemy" });
    expect(templateKeys(system)).toEqual([]);
    expect(system).toContain("humanoid|beast");
    expect(system).toContain("glowing_eyes");
    expect(user).toContain("<concept>");
    expect(user).toContain("&lt;b&gt;");
    const block = /EXAMPLE\n(\{[^\n]*\})/.exec(system)?.[1];
    expect(SpriteSpecDraftSchema.safeParse(extractJson(block ?? "")).success).toBe(true);
  });

  it("the example response in dm-system.md is valid", () => {
    const block = /```json\n([\s\S]*?)\n```/.exec(loadPrompt("dm-system"))?.[1];
    const parsed = DmResponseSchema.safeParse(extractJson(block ?? ""));
    expect(parsed.error?.issues).toBeUndefined();
    expect(parsed.success).toBe(true);
  });
});
