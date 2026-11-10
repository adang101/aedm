import { describe, expect, it } from "vitest";
import { DAMAGE_TYPES, MATERIAL_ID_RX, MATERIAL_ROLES, MaterialSchema, PATTERNS, inPalette, isHex } from "@aedm/schemas";
import type { MaterialDraft, MaterialRole, Mood } from "@aedm/schemas";
import { MATERIALS, MATERIAL_IDS, closestPattern, getMaterial, resolveMaterial } from "./materials";
import { MapRng } from "./prng";

const ctx = { tags: [] as string[], mood: "neutral" as Mood };

describe("material library", () => {
  it("has a few hundred at most, with unique snake_case ids and valid schemas", () => {
    expect(MATERIALS.length).toBeGreaterThanOrEqual(80);
    expect(MATERIALS.length).toBeLessThanOrEqual(200);
    expect(new Set(MATERIAL_IDS).size).toBe(MATERIALS.length);
    for (const m of MATERIALS) {
      expect(m.id).toMatch(MATERIAL_ID_RX);
      expect(MaterialSchema.safeParse(m).success, m.id).toBe(true);
      expect(getMaterial(m.id)).toBe(m);
    }
  });

  it("uses only master palette colors and allowed patterns", () => {
    for (const m of MATERIALS) {
      expect(inPalette(m.color), `${m.id} color`).toBe(true);
      expect(inPalette(m.accent), `${m.id} accent`).toBe(true);
      expect(PATTERNS).toContain(m.pattern);
    }
  });

  it("covers every role, with sensible walkability", () => {
    for (const role of MATERIAL_ROLES) expect(MATERIALS.filter((m) => m.role === role).length, role).toBeGreaterThanOrEqual(5);
    for (const m of MATERIALS) {
      if (m.role === "wall") expect(m.walkable).toBe(false);
      if (m.role === "wall") expect(m.blocks_sight).toBe(true);
      if (m.role === "obstacle") expect(m.walkable).toBe(false);
      if (["floor", "path", "hazard", "decor", "door"].includes(m.role)) expect(m.walkable).toBe(true);
    }
    // some liquids are walkable shallows, most are not
    expect(MATERIALS.filter((m) => m.role === "liquid" && m.walkable).length).toBeGreaterThanOrEqual(2);
    expect(MATERIALS.filter((m) => m.role === "liquid" && !m.walkable).length).toBeGreaterThanOrEqual(5);
  });

  it("gives every hazard a damage type and dice, and nothing else", () => {
    const hazards = MATERIALS.filter((m) => m.role === "hazard");
    expect(hazards.length).toBeGreaterThanOrEqual(8);
    for (const m of hazards) {
      expect(DAMAGE_TYPES).toContain(m.hazard?.damage_type);
      expect(m.hazard?.dice).toMatch(/^[1-8]d(4|6|8|10|12)$/);
    }
    expect(new Set(hazards.map((m) => m.hazard!.damage_type)).size).toBeGreaterThanOrEqual(6);
    for (const m of MATERIALS) if (m.role !== "hazard") expect(m.hazard).toBeUndefined();
  });

  it("keeps trait text free of franchise talk and within the length limit", () => {
    for (const m of MATERIALS) {
      expect(m.prompt_traits.length).toBeLessThanOrEqual(120);
      expect(m.tags.length).toBeLessThanOrEqual(6);
    }
  });
});

describe("resolveMaterial", () => {
  it("resolves an exact id", () => {
    expect(resolveMaterial("oak_tree", "obstacle", ctx).id).toBe("oak_tree");
    expect(resolveMaterial("  LAVA ", "liquid", ctx).id).toBe("lava");
  });

  it("resolves a normalized name or an alias within the role", () => {
    expect(resolveMaterial("Oak Tree", "obstacle", ctx).id).toBe("oak_tree");
    expect(resolveMaterial("Stone Brick Wall", "wall", ctx).id).toBe("stone_brick_wall");
    expect(resolveMaterial("tree", "obstacle", ctx).id).toBe("oak_tree");
    expect(resolveMaterial("magma", "liquid", ctx).id).toBe("lava");
    expect(resolveMaterial("stone floor", "floor", ctx).role).toBe("floor");
    expect(resolveMaterial("spikes", "hazard", ctx).id).toBe("spike_trap");
    expect(resolveMaterial("pine trees", "obstacle", ctx).id).toBe("pine_tree");
  });

  it("does not hand back a material of the wrong role", () => {
    for (const role of MATERIAL_ROLES) {
      for (const ref of ["oak_tree", "lava", "stone_brick_wall", "treasure_chest", "xyzzy"]) expect(resolveMaterial(ref, role, ctx).role).toBe(role);
    }
  });

  it("falls back to tags and words within the role", () => {
    expect(resolveMaterial("glassy surface", "floor", ctx).tags).toContain("glassy");
    expect(resolveMaterial("frozen wasteland", "floor", ctx).tags).toContain("cold");
    expect(resolveMaterial("bubbling lava flow", "liquid", ctx).id).toBe("lava");
    expect(resolveMaterial("scorched ground", "hazard", { tags: ["volcanic"], mood: "dark" }).role).toBe("hazard");
    expect(resolveMaterial("slimy sewer", "wall", ctx).id).toBe("sewer_brick_wall");
  });

  it("uses the role default when nothing matches, nudged by context", () => {
    const a = resolveMaterial("qwertyuiop", "floor", ctx);
    expect(a.role).toBe("floor");
    const cold = resolveMaterial("qwertyuiop", "floor", { tags: ["cold"], mood: "neutral" });
    expect(cold.tags).toContain("cold");
    expect(resolveMaterial("qwertyuiop", "floor", { tags: ["cold"], mood: "neutral" })).toBe(cold);
  });

  it("validates a draft: snaps colors, maps the pattern, defaults by role, derives the id", () => {
    const m = resolveMaterial(
      { name: "Gumdrop Ground", role: "floor", color: "#ff69b4", accent: "#fffacd", pattern: "polka dots", tags: ["sweet", "pink"], prompt_traits: "pink sugar crystals" },
      "floor",
      ctx,
    );
    expect(m.id).toBe("custom_gumdrop_ground");
    expect(inPalette(m.color)).toBe(true);
    expect(inPalette(m.accent)).toBe(true);
    expect(m.pattern).toBe("dots");
    expect(m).toMatchObject({ role: "floor", walkable: true, blocks_sight: false, tags: ["sweet", "pink"] });
    expect(MaterialSchema.safeParse(m).success).toBe(true);
    const wall = resolveMaterial({ name: "Licorice Wall", role: "wall", color: "#101010", tags: [], prompt_traits: "" }, "wall", ctx);
    expect(wall).toMatchObject({ walkable: false, blocks_sight: true });
    expect(inPalette(wall.accent)).toBe(true);
    const glass = resolveMaterial({ name: "Glass wall", role: "wall", color: "#9fd4f5", blocks_sight: false, tags: [], prompt_traits: "" }, "wall", ctx);
    expect(glass.blocks_sight).toBe(false);
  });

  it("maps unknown patterns to the closest allowed one, else none", () => {
    expect(closestPattern("brickwork")).toBe("bricks");
    expect(closestPattern("wavy lines")).toBe("waves");
    expect(closestPattern("sparkly")).toBe("none");
    expect(closestPattern(undefined)).toBe("none");
    expect(closestPattern("cobbles")).toBe("cobbles");
    const m = resolveMaterial({ name: "Odd", role: "decor", color: "#123456", pattern: "zzz", tags: [], prompt_traits: "" }, "decor", ctx);
    expect(m.pattern).toBe("none");
    expect(PATTERNS).toContain(m.pattern);
  });

  it("gives hazard drafts dice and keeps a valid one", () => {
    const d = resolveMaterial({ name: "Bile", role: "hazard", color: "#22aa22", tags: [], prompt_traits: "" }, "hazard", ctx);
    expect(d.hazard).toEqual({ damage_type: "sharp", dice: "1d4" });
    const k = resolveMaterial({ name: "Bile", role: "hazard", color: "#22aa22", hazard: { damage_type: "acid", dice: "2d6" }, tags: [], prompt_traits: "" }, "hazard", ctx);
    expect(k.hazard).toEqual({ damage_type: "acid", dice: "2d6" });
    expect(resolveMaterial({ name: "Bile", role: "floor", color: "#22aa22", hazard: { damage_type: "acid", dice: "2d6" }, tags: [], prompt_traits: "" } as MaterialDraft, "floor", ctx).hazard).toBeUndefined();
  });

  it("is deterministic and never throws (fuzz)", () => {
    const rng = new MapRng(99);
    const junk: unknown[] = [
      "", "   ", "💥", "a".repeat(500), "UPPER_CASE", "__", "123", null, undefined, 42, {}, [], { name: "" }, { name: 5, role: "floor" },
      { name: "x", role: "nope", color: "red" }, { name: "x", role: "floor", color: "#12" }, { name: "x".repeat(200), role: "wall", color: "#ffffff", tags: Array(20).fill("tag") },
    ];
    const hex = () => `#${rng.int(0, 0xffffff).toString(16).padStart(6, "0")}`;
    for (let i = 0; i < 400; i++) {
      const role = rng.pick(MATERIAL_ROLES) as MaterialRole;
      const ref = (i < junk.length ? junk[i] : rng.chance(0.5)
        ? rng.pick(MATERIAL_IDS) + (rng.chance(0.3) ? " thing" : "")
        : { name: `Thing ${i}`, role, color: hex(), accent: rng.chance(0.5) ? hex() : undefined, pattern: rng.chance(0.5) ? "wobbly" : undefined, tags: [], prompt_traits: "" }) as never;
      const a = resolveMaterial(ref, role, { tags: ["x"], mood: rng.pick(["bright", "dark", "eerie"] as const) });
      expect(MaterialSchema.safeParse(a).success).toBe(true);
      expect(a.role).toBe(role);
      expect(isHex(a.color) && inPalette(a.color) && inPalette(a.accent)).toBe(true);
    }
    expect(resolveMaterial({ name: "Same", role: "floor", color: "#aaaaaa", tags: [], prompt_traits: "" }, "floor", ctx)).toEqual(
      resolveMaterial({ name: "Same", role: "floor", color: "#aaaaaa", tags: [], prompt_traits: "" }, "floor", ctx),
    );
  });
});
