import { describe, expect, it } from "vitest";
import { SpriteRecipeSchema, spriteSwatch } from "./character";
import { AssetRecordSchema } from "./asset";
import { BODY_PLANS, PART_CATALOG, PART_GROUPS, SpriteSpecDraftSchema, SpriteSpecSchema, isPart } from "./sprite";

const spec = {
  kind: "spec", v: 1, body: "humanoid", size: "medium",
  palette: { primary: "#3d2a6b", secondary: "#6a45a8", accent: "#cbb0f0", detail: "#1b1626" },
  parts: [{ part: "robe", color: "primary" }, { part: "hood", color: "secondary" }, { part: "glowing_eyes", color: "accent" }, { part: "staff", side: "right" }],
  glyph: "Ch", pose: "idle", traits: "robed chorister, drowned-blue cloth, dripping hem",
};
const shape = { kind: "shape", shape: "circle", color: "#112233", accent: "#445566", glyph: "A" };

describe("catalog", () => {
  it("has 10 body plans and about 45 parts with no duplicates", () => {
    expect(BODY_PLANS).toHaveLength(10);
    expect(PART_CATALOG.length).toBeGreaterThanOrEqual(30);
    expect(PART_CATALOG.length).toBeLessThanOrEqual(48);
    expect(new Set(PART_CATALOG).size).toBe(PART_CATALOG.length);
    expect(Object.keys(PART_GROUPS)).toEqual(["head", "body", "held", "aura"]);
    expect(isPart("horns")).toBe(true);
    expect(isPart("jetpack")).toBe(false);
  });
});

describe("SpriteSpec (strict)", () => {
  it("parses", () => {
    const r = SpriteSpecSchema.safeParse(spec);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
  it("enforces catalog parts, at most 6 parts, glyph, traits and palette hex", () => {
    expect(SpriteSpecSchema.safeParse({ ...spec, parts: [{ part: "jetpack" }] }).success).toBe(false);
    expect(SpriteSpecSchema.safeParse({ ...spec, parts: Array.from({ length: 7 }, () => ({ part: "horns" })) }).success).toBe(false);
    expect(SpriteSpecSchema.safeParse({ ...spec, glyph: "abc" }).success).toBe(false);
    expect(SpriteSpecSchema.safeParse({ ...spec, traits: "x".repeat(161) }).success).toBe(false);
    expect(SpriteSpecSchema.safeParse({ ...spec, palette: { ...spec.palette, accent: "red" } }).success).toBe(false);
    expect(SpriteSpecSchema.safeParse({ ...spec, body: "dragon" }).success).toBe(false);
    expect(SpriteSpecSchema.safeParse({ ...spec, size: "gigantic" }).success).toBe(false);
    expect(SpriteSpecSchema.safeParse({ ...spec, parts: [{ part: "horns", side: "up" }] }).success).toBe(false);
    expect(SpriteSpecSchema.safeParse({ ...spec, v: 2 }).success).toBe(false);
  });
  it("allows optional glyph, pose, image_asset_id", () => {
    const { glyph: _g, pose: _p, ...bare } = spec;
    expect(SpriteSpecSchema.safeParse(bare).success).toBe(true);
    expect(SpriteSpecSchema.safeParse({ ...bare, image_asset_id: "as_abc" }).success).toBe(true);
  });
});

describe("SpriteSpecDraft (lenient)", () => {
  const draft = { body: "beast", palette: { primary: "#101010", secondary: "#aa5500", accent: "#00ff00", detail: "#ffffff" }, parts: [{ part: "jetpack" }, { part: "horns" }] };
  it("accepts unknown part strings, any hex, missing size and traits", () => {
    const r = SpriteSpecDraftSchema.safeParse(draft);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ size: "medium", traits: "" });
  });
  it("still rejects bad body, bad hex and overlong part names", () => {
    expect(SpriteSpecDraftSchema.safeParse({ ...draft, body: "dragon" }).success).toBe(false);
    expect(SpriteSpecDraftSchema.safeParse({ ...draft, palette: { ...draft.palette, primary: "green" } }).success).toBe(false);
    expect(SpriteSpecDraftSchema.safeParse({ ...draft, parts: [{ part: "x".repeat(25) }] }).success).toBe(false);
  });
  it("the same draft fails the strict schema (engine must clean it)", () => {
    expect(SpriteSpecSchema.safeParse({ kind: "spec", v: 1, size: "medium", traits: "", ...draft }).success).toBe(false);
  });
});

describe("SpriteRecipe union", () => {
  it("accepts both shape and spec, rejects others", () => {
    expect(SpriteRecipeSchema.safeParse(shape).success).toBe(true);
    expect(SpriteRecipeSchema.safeParse(spec).success).toBe(true);
    expect(SpriteRecipeSchema.safeParse({ kind: "parts" }).success).toBe(false);
    expect(SpriteRecipeSchema.safeParse({ ...shape, shape: "star" }).success).toBe(false);
  });
  it("spriteSwatch works for either kind", () => {
    expect(spriteSwatch(shape as never)).toEqual({ color: "#112233", accent: "#445566", glyph: "A" });
    expect(spriteSwatch(spec as never)).toEqual({ color: "#3d2a6b", accent: "#cbb0f0", glyph: "Ch" });
    const { glyph: _g, ...noGlyph } = spec;
    expect(spriteSwatch(noGlyph as never, "orrin").glyph).toBe("O");
  });
});

describe("AssetRecord", () => {
  const base = { id: "as_1", key: "abc123", created_at: "2026-01-01T00:00:00Z", uses: 0 };
  it("matches spec to kind", () => {
    expect(AssetRecordSchema.safeParse({ ...base, kind: "sprite", spec }).success).toBe(true);
    expect(AssetRecordSchema.safeParse({ ...base, kind: "material", spec }).success).toBe(false);
    expect(AssetRecordSchema.safeParse({ ...base, kind: "setting", spec: { name: "Glacier rift", layout: "cave", environment: "outdoor", mood: "bright" } }).success).toBe(true);
    expect(AssetRecordSchema.safeParse({ ...base, id: "x1", kind: "sprite", spec }).success).toBe(false);
    expect(AssetRecordSchema.safeParse({ ...base, uses: -1, kind: "sprite", spec }).success).toBe(false);
  });
});
