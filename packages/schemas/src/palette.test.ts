import { describe, expect, it } from "vitest";
import { OUTLINE_HEX, PALETTE, PALETTE_HEX, RAMP_NAMES, inPalette, isHex, snapToPalette } from "./palette";

describe("palette", () => {
  it("has 8 ramps of 4 plus the outline, all distinct valid hex", () => {
    expect(RAMP_NAMES).toHaveLength(8);
    for (const r of RAMP_NAMES) expect(PALETTE[r]).toHaveLength(4);
    expect(PALETTE_HEX).toHaveLength(33);
    expect(new Set(PALETTE_HEX).size).toBe(33);
    expect(PALETTE_HEX.every(isHex)).toBe(true);
    expect(PALETTE_HEX).toContain(OUTLINE_HEX);
  });
  it("matches the style bible", () => {
    expect(PALETTE.grass[0]).toBe("#2f5d34");
    expect(PALETTE.skin[3]).toBe("#f2cfa6");
    expect(OUTLINE_HEX).toBe("#1b1626");
  });
  it("snaps palette colors to themselves, case-insensitively", () => {
    for (const h of PALETTE_HEX) expect(snapToPalette(h)).toBe(h);
    expect(snapToPalette("#2F5D34")).toBe("#2f5d34");
  });
  it("snaps near colors to the nearest palette color", () => {
    expect(snapToPalette("#ff0000")).toBe(PALETTE.fire[1]); // red -> fire mid-dark
    expect(snapToPalette("#2060b0")).toBe(PALETTE.water[1]);
    expect(snapToPalette("#ffffff")).toBe(PALETTE.sand[3]);
    expect(snapToPalette("#000000")).toBe(OUTLINE_HEX);
    expect(snapToPalette("#4e8b3d")).toBe(PALETTE.grass[1]);
  });
  it("is idempotent and deterministic", () => {
    for (const h of ["#123456", "#abcdef", "#808080", "#ff00ff"]) {
      const s = snapToPalette(h);
      expect(inPalette(s)).toBe(true);
      expect(snapToPalette(s)).toBe(s);
      expect(snapToPalette(h)).toBe(s);
    }
  });
  it("isHex and bad input", () => {
    expect(isHex("#a1B2c3")).toBe(true);
    for (const bad of ["a1b2c3", "#abc", "#12345g", "", 5, null]) expect(isHex(bad)).toBe(false);
    expect(() => snapToPalette("red")).toThrow();
  });
});
