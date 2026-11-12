import { describe, expect, it } from "vitest";
import { PIXEL_COUNT, PIXEL_HEIGHT, PIXEL_WIDTH, PALETTE_HEX, encodePixels, type PixelSprite } from "@aedm/schemas";
import { PIXEL_RULES } from "./data.ts";
import { feetRow, shiftToFeet, validatePixelSprite } from "./pixel.ts";

const W = PIXEL_WIDTH;
/** A block of color index 1 at x0..x1, y0..y1 inclusive. */
function make(rect: [number, number, number, number] = [16, 10, 31, 60], over: Partial<PixelSprite> = {}, edit?: (a: Uint8Array) => void): PixelSprite {
  const a = new Uint8Array(PIXEL_COUNT);
  for (let y = rect[1]; y <= rect[3]; y++) for (let x = rect[0]; x <= rect[2]; x++) a[y * W + x] = 1;
  edit?.(a);
  return { kind: "pixel", v: 1, width: 48, height: 64, palette: [PALETTE_HEX[0]!, PALETTE_HEX[5]!], pixels: encodePixels(a), size: "medium", traits: "", ...over };
}
const errs = (s: PixelSprite) => { const r = validatePixelSprite(s); return r.ok ? [] : r.errors.map((e) => e.code); };

describe("pixel rules data", () => {
  it("matches the design numbers", () => {
    expect(PIXEL_RULES).toMatchObject({ maxColors: 32, minOpaque: 60, margin: 2, feetY: 60, feetTolerance: 4 });
  });
});

describe("validatePixelSprite", () => {
  it("accepts a sound sprite", () => {
    const r = validatePixelSprite(make());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.opaque).toBe(16 * 51);
  });
  it("rejects a wrong canvas size", () => {
    expect(errs({ ...make(), width: 32 } as unknown as PixelSprite)).toContain("size");
  });
  it("rejects data that does not decode to 48 x 64", () => {
    expect(errs(make(undefined, { pixels: ".100" }))).toContain("size");
  });
  it("rejects an index outside the palette", () => {
    expect(errs(make(undefined, {}, (a) => { a[30 * W + 20] = 3; }))).toContain("index");
  });
  it("rejects a palette color off the master palette", () => {
    expect(errs(make(undefined, { palette: ["#123456", PALETTE_HEX[5]!] }))).toContain("palette");
  });
  it("rejects more than 32 colors", () => {
    expect(errs(make(undefined, { palette: Array(33).fill(PALETTE_HEX[0]!) }))).toContain("colors");
  });
  it("rejects fewer than 60 opaque pixels, accepts exactly 60", () => {
    expect(errs(make([20, 56, 28, 61]))).toContain("opaque"); // 9 x 6 = 54
    expect(errs(make([20, 52, 29, 57]))).not.toContain("opaque"); // 10 x 6 = 60, feet 57
  });
  it("rejects opaque pixels within 2 px of the edge", () => {
    expect(errs(make([1, 10, 30, 60]))).toContain("margin");
    expect(errs(make([2, 10, 30, 60]))).not.toContain("margin");
    expect(errs(make([16, 1, 31, 60]))).toContain("margin");
    expect(errs(make([16, 10, 46, 60]))).toContain("margin");
    expect(errs(make([16, 10, 31, 62]))).toContain("margin");
  });
  it("checks the feet within the tolerance of y = 60", () => {
    expect(errs(make([16, 10, 31, 55]))).toContain("feet");
    expect(errs(make([16, 10, 31, 56]))).not.toContain("feet");
    expect(errs(make([16, 10, 31, 61]))).not.toContain("feet");
  });
  it("rejects a recipe larger than the byte limit", () => {
    const noisy = make(undefined, { traits: "x".repeat(160) }, (a) => { for (let i = 0; i < a.length; i++) a[i] = (i * 31 + (i >> 3)) % 2; });
    const size = new TextEncoder().encode(JSON.stringify(noisy)).length;
    expect(size).toBeLessThan(PIXEL_RULES.maxRecipeBytes); // even the worst case fits the limit today
    const saved = PIXEL_RULES.maxRecipeBytes;
    try {
      PIXEL_RULES.maxRecipeBytes = size - 1;
      expect(errs(noisy)).toContain("bytes");
      PIXEL_RULES.maxRecipeBytes = size;
      expect(errs(noisy)).not.toContain("bytes");
    } finally { PIXEL_RULES.maxRecipeBytes = saved; }
  });
  it("reports several problems at once with readable messages", () => {
    const r = validatePixelSprite(make([0, 0, 3, 3]));
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.errors.length).toBeGreaterThanOrEqual(3); for (const e of r.errors) expect(e.message.length).toBeGreaterThan(5); }
  });
});

describe("shiftToFeet", () => {
  it("moves a sprite up or down so the feet land on y = 60", () => {
    const s = shiftToFeet(make([16, 10, 31, 40]));
    expect(feetRow(s)).toBe(PIXEL_RULES.feetY);
    expect(validatePixelSprite(s).ok).toBe(true);
  });
  it("leaves a sprite inside the tolerance alone", () => {
    const s = make([16, 10, 31, 58]);
    expect(shiftToFeet(s)).toBe(s);
  });
  it("leaves the sprite unchanged when shifting would break the margins", () => {
    const s = make([16, 0, 31, 63]);
    expect(shiftToFeet(s)).toBe(s);
  });
  it("returns blank or malformed sprites unchanged", () => {
    const s = make(undefined, { pixels: ".3072" });
    expect(shiftToFeet(s)).toBe(s);
  });
});

it("constants are consistent", () => { expect(PIXEL_HEIGHT).toBe(64); });
