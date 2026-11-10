import { describe, expect, it } from "vitest";
import { MapSchema, SpriteSpecSchema, inPalette } from "@aedm/schemas";
import { buildScenes } from "../net/mock-world";
import { buildCreate, emptyForm, premadeForms } from "./creator";
import {
  MAX_BUILDER_PARTS, PREMADE_SPECS, buildSpriteSpec, defaultSpriteForm, randomLook, togglePart,
} from "./sprite-builder";

describe("sprite builder", () => {
  it("builds a spec that validates", () => {
    const spec = buildSpriteSpec(defaultSpriteForm(), "Brindle");
    expect(SpriteSpecSchema.safeParse(spec).success).toBe(true);
    expect(spec.glyph).toBe("B");
    expect(buildSpriteSpec(defaultSpriteForm(), "").glyph).toBeUndefined();
  });
  it("allows at most four parts", () => {
    let p: ReturnType<typeof togglePart> = [];
    for (const x of ["horns", "hood", "sword", "aura", "wings"] as const) p = togglePart(p, x);
    expect(p).toHaveLength(MAX_BUILDER_PARTS);
    expect(togglePart(p, "horns")).not.toContain("horns");
  });
  it("randomizes deterministically from the name and counter, with palette colors", () => {
    const a = randomLook("Brindle", 1), b = randomLook("Brindle", 1), c = randomLook("Brindle", 2);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    for (let i = 0; i < 40; i++) {
      const f = randomLook("x" + i, i);
      expect(f.parts.length).toBeGreaterThan(0);
      expect(f.parts.length).toBeLessThanOrEqual(MAX_BUILDER_PARTS);
      for (const col of Object.values(f.palette)) expect(inPalette(col)).toBe(true);
      expect(SpriteSpecSchema.safeParse(buildSpriteSpec(f, "x")).success).toBe(true);
    }
  });
  it("gives premades valid specs and puts them in the claim payload", () => {
    for (const s of Object.values(PREMADE_SPECS)) expect(SpriteSpecSchema.safeParse(s).success).toBe(true);
    for (const p of premadeForms()) {
      const r = buildCreate(p.form);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.sprite_recipe?.kind).toBe("spec");
    }
    expect(emptyForm().sprite.body).toBe("humanoid");
  });
});

describe("mock maps", () => {
  it("are valid v2 maps with their own tilesets", () => {
    const scenes = buildScenes();
    expect(Object.keys(scenes).sort()).toEqual(["m_crypt", "m_hollowmere", "m_trail"]);
    for (const s of Object.values(scenes)) {
      expect(MapSchema.safeParse(s.map).success, s.id).toBe(true);
      for (const e of s.entities) expect(e.sprite.kind).toBe("spec");
    }
    expect(scenes.m_crypt!.map.meta.setting.mood).toBe("eerie");
  });
  it("cover every body plan across the cast", () => {
    const bodies = new Set<string>(Object.values(buildScenes()).flatMap((s) => s.entities.map((e) => (e.sprite.kind === "spec" ? e.sprite.body : ""))));
    for (const b of ["humanoid", "beast", "avian", "serpent", "insectoid", "amorphous", "construct", "spirit", "plant", "object"]) expect(bodies.has(b), b).toBe(true);
  });
});
