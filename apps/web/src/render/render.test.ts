import { describe, expect, it } from "vitest";
import { BODY_PLANS, PART_CATALOG, PATTERNS, SpriteSpecSchema, inPalette, type SpriteSpec } from "@aedm/schemas";
import { OUTLINE, mixHex, shade, tones } from "./palette";
import { PATTERN_DRAWERS } from "./patterns";
import { PROP_KINDS, hazardMotifFor, propKindFor } from "./props";
import { FEET_Y, SIZE_SCALE, anchorsFor } from "./sprite-anchors";
import { BODY_DRAWERS } from "./sprite-bodies";
import { DRAWABLE_PARTS, composeKey, specHash, specKey } from "./sprite-composer";
import { PART_DRAWERS } from "./sprite-parts";
import { tileClassOf } from "./tiles";

const spec = (over: Partial<SpriteSpec> = {}): SpriteSpec => ({
  kind: "spec", v: 1, body: "humanoid", size: "medium", traits: "",
  palette: { primary: "#d39a72", secondary: "#2f6bb5", accent: "#e8c95a", detail: "#70472f" },
  parts: [{ part: "sword" }, { part: "hood", color: "accent" }], ...over,
});

describe("shade along palette ramps", () => {
  it("moves one step along a ramp", () => {
    expect(shade("#4f8a3c", 1)).toBe("#7cb342");
    expect(shade("#4f8a3c", -1)).toBe("#2f5d34");
    expect(shade("#4F8A3C", 2)).toBe("#b5d66b");
  });
  it("continues past the ends toward white and the outline", () => {
    expect(shade("#b5d66b", 1)).not.toBe("#b5d66b");
    expect(shade("#2f5d34", -1)).not.toBe("#2f5d34");
    expect(shade("#2f5d34", -1)).toMatch(/^#[0-9a-f]{6}$/);
  });
  it("lightens and darkens a color that is not on a ramp", () => {
    expect(shade("#123456", 1)).not.toBe("#123456");
    expect(shade("#123456", 0)).toBe("#123456");
    expect(shade("#808080", -1)).toBe(mixHex("#808080", OUTLINE, 0.3));
  });
  it("gives four tones that stay on the ramp for a mid color", () => {
    const t = tones("#4f8a3c");
    expect([t.hi, t.base, t.sh, t.dk]).toEqual(["#7cb342", "#4f8a3c", "#2f5d34", shade("#4f8a3c", -2)]);
  });
});

describe("spec keys", () => {
  it("is stable and changes with anything drawn", () => {
    expect(specKey(spec())).toBe(specKey(spec()));
    expect(specHash(spec())).toMatch(/^[0-9a-f]{8}$/);
    expect(specHash(spec())).toBe(specHash(spec()));
    expect(specKey(spec({ size: "large" }))).not.toBe(specKey(spec()));
    expect(specKey(spec({ parts: [{ part: "hood" }] }))).not.toBe(specKey(spec()));
    expect(specKey(spec({ palette: { ...spec().palette, accent: "#c0392b" } }))).not.toBe(specKey(spec()));
  });
  it("ignores traits, which do not change the drawing", () => {
    expect(specKey(spec({ traits: "a robed figure" }))).toBe(specKey(spec()));
  });
  it("keys the cache by facing, frame and pose", () => {
    const a = composeKey(spec(), "left", 0, "idle");
    expect(a).not.toBe(composeKey(spec(), "right", 0, "idle"));
    expect(a).not.toBe(composeKey(spec(), "left", 1, "idle"));
    expect(a).not.toBe(composeKey(spec(), "left", 0, "cowering"));
    expect(composeKey(spec(), "left", 2, "idle")).toBe(a);
  });
});

describe("anchors per body plan", () => {
  it("keeps every anchor inside the 48 x 64 canvas, hands apart, head above the feet", () => {
    for (const b of BODY_PLANS) {
      const a = anchorsFor(b);
      const pts = [a.headTop, a.headFront, a.neck, a.back, a.handL, a.handR, a.tailBase, ...a.eyes];
      for (const p of pts) {
        expect(p.x, `${b} x`).toBeGreaterThanOrEqual(0); expect(p.x, `${b} x`).toBeLessThanOrEqual(48);
        expect(p.y, `${b} y`).toBeGreaterThanOrEqual(0); expect(p.y, `${b} y`).toBeLessThanOrEqual(FEET_Y + 4);
      }
      expect(a.handR.x, b).toBeGreaterThan(a.handL.x);
      expect(a.headTop.y, b).toBeLessThan(a.torso.cy + a.torso.ry);
      expect(a.garment.hem, b).toBeGreaterThan(a.garment.top);
      expect(a.garment.hem, b).toBeLessThanOrEqual(FEET_Y);
      expect(a.eyes.length, b).toBeGreaterThan(0);
    }
  });
  it("uses the style bible neck anchor and feet line for the humanoid", () => {
    const a = anchorsFor("humanoid");
    expect(a.neck).toEqual({ x: 24, y: 32 });
    expect(FEET_Y).toBe(60);
  });
  it("raises the right hand when aggressive", () => {
    expect(anchorsFor("humanoid", "aggressive").handR.y).toBeLessThan(anchorsFor("humanoid").handR.y);
  });
  it("scales sizes as specified", () => {
    expect(SIZE_SCALE).toEqual({ tiny: 0.6, small: 0.8, medium: 1, large: 1.3, huge: 1.6 });
  });
});

describe("registries cover the schema", () => {
  it("has a pattern routine for every PATTERN", () => {
    expect(Object.keys(PATTERN_DRAWERS).sort()).toEqual([...PATTERNS].sort());
    expect(PATTERNS.length).toBe(19);
  });
  it("has a part renderer for every PART_CATALOG entry (and no extras)", () => {
    expect(Object.keys(PART_DRAWERS).sort()).toEqual([...PART_CATALOG].sort());
    expect([...DRAWABLE_PARTS].sort()).toEqual([...PART_CATALOG].sort());
  });
  it("has a body routine for every body plan", () => {
    expect(Object.keys(BODY_DRAWERS).sort()).toEqual([...BODY_PLANS].sort());
  });
});

describe("tile roles and props", () => {
  it("classifies roles", () => {
    expect(tileClassOf("wall")).toBe("wall");
    expect(tileClassOf("obstacle")).toBe("prop");
    expect(tileClassOf("decor")).toBe("prop");
    expect(tileClassOf("liquid")).toBe("full");
    expect(tileClassOf("door")).toBe("full");
  });
  it("picks props from material ids and falls back by role and pattern", () => {
    expect(propKindFor({ material_id: "snowy_pine", role: "obstacle", pattern: "grass" })).toBe("pine");
    expect(propKindFor({ material_id: "trail_signpost", role: "decor", pattern: "planks" })).toBe("sign");
    expect(propKindFor({ material_id: "weird_thing", role: "obstacle", pattern: "grass" })).toBe("bush");
    expect(propKindFor({ material_id: "weird_thing", role: "decor", pattern: "none" })).toBe("block");
    for (const k of PROP_KINDS) expect(typeof k).toBe("string");
  });
  it("picks hazard motifs", () => {
    expect(hazardMotifFor({ material_id: "lava_pool", pattern: "cracks" })).toBe("flames");
    expect(hazardMotifFor({ material_id: "spike_trap", pattern: "none" })).toBe("spikes");
    expect(hazardMotifFor({ material_id: "mystery", pattern: "none" })).toBe("warning");
  });
  it("snaps nothing: palette colors are valid", () => {
    expect(inPalette("#4f8a3c")).toBe(true);
    expect(SpriteSpecSchema.safeParse(spec()).success).toBe(true);
  });
});
