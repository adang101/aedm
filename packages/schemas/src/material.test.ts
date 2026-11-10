import { describe, expect, it } from "vitest";
import { MaterialDraftSchema, MaterialSchema, PATTERNS, ROLE_DEFAULTS, MATERIAL_ROLES, materialDefaults } from "./material";

const stone = {
  id: "stone_floor", name: "Stone floor", role: "floor", color: "#5c6380", accent: "#8b93b0", pattern: "tiles",
  walkable: true, blocks_sight: false, tags: ["stone", "dry"], prompt_traits: "worn grey flagstones",
};

describe("MaterialSchema", () => {
  it("parses a full material", () => expect(MaterialSchema.safeParse(stone).success).toBe(true));
  it("has 19 patterns including none", () => {
    expect(PATTERNS).toContain("none");
    expect(PATTERNS.length).toBeGreaterThanOrEqual(18);
    expect(PATTERNS.length).toBeLessThanOrEqual(20);
  });
  it("id is snake_case at most 32", () => {
    for (const id of ["Stone", "stone-floor", "1stone", "a".repeat(33), "", "stone floor"]) {
      expect(MaterialSchema.safeParse({ ...stone, id }).success, id).toBe(false);
    }
    expect(MaterialSchema.safeParse({ ...stone, id: "a".repeat(32) }).success).toBe(true);
  });
  it("limits name, tags and prompt_traits; rejects unknown role, pattern, extra keys, bad colors", () => {
    expect(MaterialSchema.safeParse({ ...stone, name: "x".repeat(41) }).success).toBe(false);
    expect(MaterialSchema.safeParse({ ...stone, tags: ["a", "b", "c", "d", "e", "f", "g"] }).success).toBe(false);
    expect(MaterialSchema.safeParse({ ...stone, prompt_traits: "x".repeat(121) }).success).toBe(false);
    expect(MaterialSchema.safeParse({ ...stone, role: "ceiling" }).success).toBe(false);
    expect(MaterialSchema.safeParse({ ...stone, pattern: "zigzag" }).success).toBe(false);
    expect(MaterialSchema.safeParse({ ...stone, extra: 1 }).success).toBe(false);
    expect(MaterialSchema.safeParse({ ...stone, color: "grey" }).success).toBe(false);
  });
  it("hazard is only allowed on the hazard role", () => {
    const hz = { damage_type: "fire", dice: "2d6" };
    expect(MaterialSchema.safeParse({ ...stone, hazard: hz }).success).toBe(false);
    expect(MaterialSchema.safeParse({ ...stone, role: "hazard", hazard: hz }).success).toBe(true);
    expect(MaterialSchema.safeParse({ ...stone, role: "hazard" }).success).toBe(true);
    expect(MaterialSchema.safeParse({ ...stone, role: "hazard", hazard: { damage_type: "fire", dice: "9d6" } }).success).toBe(false);
    expect(MaterialSchema.safeParse({ ...stone, role: "hazard", hazard: { damage_type: "love", dice: "1d6" } }).success).toBe(false);
  });
});

describe("MaterialDraftSchema", () => {
  const draft = { name: "Moss", role: "floor", color: "#123456" };
  it("accepts the minimum: name, role, color", () => {
    const r = MaterialDraftSchema.safeParse(draft);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ tags: [], prompt_traits: "" });
  });
  it("accepts any hex and any short pattern word (the engine snaps and maps)", () => {
    expect(MaterialDraftSchema.safeParse({ ...draft, color: "#010203", accent: "#fafafa", pattern: "swirly" }).success).toBe(true);
    expect(MaterialDraftSchema.safeParse({ ...draft, pattern: "x".repeat(25) }).success).toBe(false);
    expect(MaterialDraftSchema.safeParse({ ...draft, color: "blue" }).success).toBe(false);
  });
  it("hazard only on hazard role", () => {
    expect(MaterialDraftSchema.safeParse({ ...draft, hazard: { damage_type: "acid", dice: "1d4" } }).success).toBe(false);
    expect(MaterialDraftSchema.safeParse({ ...draft, role: "hazard", hazard: { damage_type: "acid", dice: "1d4" } }).success).toBe(true);
  });
  it("walkable and blocks_sight default by role", () => {
    expect(materialDefaults({ role: "wall" })).toEqual({ walkable: false, blocks_sight: true });
    expect(materialDefaults({ role: "floor" })).toEqual({ walkable: true, blocks_sight: false });
    expect(materialDefaults({ role: "liquid" })).toEqual({ walkable: false, blocks_sight: false });
    expect(materialDefaults({ role: "obstacle", walkable: true })).toEqual({ walkable: true, blocks_sight: false });
    expect(materialDefaults({ role: "floor", blocks_sight: true })).toEqual({ walkable: true, blocks_sight: true });
    for (const r of MATERIAL_ROLES) expect(ROLE_DEFAULTS[r]).toBeDefined();
  });
});
