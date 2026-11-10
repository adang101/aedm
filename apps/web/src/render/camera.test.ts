import { describe, expect, it } from "vitest";
import { DESKTOP_SCALE, baseScale, clampAxis, clampCamera, screenToTile, tileToScreen } from "./camera";
import { paletteColorForGid, PALETTE } from "./palette";

describe("camera", () => {
  it("fits about 11 tiles across on phones", () => {
    expect(baseScale(528)).toBeCloseTo(1);
    expect(baseScale(360) * 48 * 11).toBeCloseTo(360);
    expect(baseScale(1280)).toBe(DESKTOP_SCALE);
  });

  it("clamps to the map and centers small maps", () => {
    expect(clampAxis(0, 500, 2000)).toBe(250);
    expect(clampAxis(5000, 500, 2000)).toBe(1750);
    expect(clampAxis(100, 500, 300)).toBe(150);
    const c = clampCamera({ cx: 0, cy: 0, zoom: 1 }, 1200, 800, 30, 20);
    expect(c.cx).toBeGreaterThan(0);
  });

  it("screen and tile coordinates round-trip", () => {
    const cam = { cx: 700, cy: 400, zoom: 1.3 };
    const s = tileToScreen(7.5, 4.25, 900, 600, cam);
    const t = screenToTile(s.x, s.y, 900, 600, cam);
    expect(t.x).toBeCloseTo(7.5);
    expect(t.y).toBeCloseTo(4.25);
  });
});

describe("palette fallback", () => {
  it("gives unknown ids a deterministic palette color", () => {
    expect(PALETTE).toContain(paletteColorForGid(99));
    expect(paletteColorForGid(99)).toBe(paletteColorForGid(99));
  });
});
