import { describe, expect, it } from "vitest";
import { SpriteRecipeSchema, spriteSwatch } from "./character";
import { PIXEL_COUNT, PixelSpriteSchema, decodePixels, encodePixels } from "./pixel";

const px = { kind: "pixel", v: 1, width: 48, height: 64, palette: ["#1b1626", "#c99a63"], pixels: encodePixels(new Uint8Array(PIXEL_COUNT)), size: "medium", traits: "" };

describe("RLE", () => {
  it("round-trips arbitrary index data", () => {
    const a = new Uint8Array(PIXEL_COUNT);
    for (let i = 0; i < a.length; i++) a[i] = (i * 7 + (i >> 5)) % 33;
    expect(decodePixels(encodePixels(a))).toEqual(a);
  });
  it("compresses a blank canvas to a few bytes", () => {
    expect(encodePixels(new Uint8Array(PIXEL_COUNT))).toBe(".3072");
  });
  it("omits counts of 1 and handles every index", () => {
    expect(encodePixels([0, 1, 1, 32])).toBe(".A2f");
    expect([...decodePixels(".A2f", 4)!]).toEqual([0, 1, 1, 32]);
  });
  it("rejects bad length, bad symbols and zero counts", () => {
    expect(decodePixels(".3071")).toBeUndefined();
    expect(decodePixels(".3073")).toBeUndefined();
    expect(decodePixels("!3072")).toBeUndefined();
    expect(decodePixels(".0")).toBeUndefined();
    expect(decodePixels("")).toBeUndefined();
  });
  it("encode refuses out-of-range indices", () => {
    expect(() => encodePixels([33])).toThrow();
  });
});

describe("PixelSprite schema", () => {
  it("parses inside the recipe union", () => {
    expect(PixelSpriteSchema.safeParse(px).success).toBe(true);
    expect(SpriteRecipeSchema.safeParse(px).success).toBe(true);
  });
  it("rejects wrong size, empty or oversized palette, malformed data and extra keys", () => {
    expect(PixelSpriteSchema.safeParse({ ...px, width: 32 }).success).toBe(false);
    expect(PixelSpriteSchema.safeParse({ ...px, palette: [] }).success).toBe(false);
    expect(PixelSpriteSchema.safeParse({ ...px, palette: Array(33).fill("#1b1626") }).success).toBe(false);
    expect(PixelSpriteSchema.safeParse({ ...px, pixels: "zz!" }).success).toBe(false);
    expect(PixelSpriteSchema.safeParse({ ...px, extra: 1 }).success).toBe(false);
  });
  it("has a swatch", () => {
    expect(spriteSwatch(PixelSpriteSchema.parse(px), "Bo").glyph).toBe("B");
  });
});
