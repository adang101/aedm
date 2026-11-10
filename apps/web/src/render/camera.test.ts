import { describe, expect, it } from "vitest";
import { DESKTOP_SCALE, baseScale, clampAxis, clampCamera, screenToTile, tileToScreen } from "./camera";
import { paletteColorForGid, PALETTE } from "./palette";
import { clearTileset, setTileset, tileStyle } from "./tileset";

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

describe("tileset", () => {
  it("falls back to a deterministic palette color for unknown gids", () => {
    clearTileset();
    expect(tileStyle(99).color).toBe(paletteColorForGid(99));
    expect(PALETTE).toContain(tileStyle(99).color);
    expect(tileStyle(99)).toEqual(tileStyle(99));
  });

  it("uses an installed tileset, offset by first_gid", () => {
    clearTileset();
    setTileset({ first_gid: 10, tiles: [{ id: 1, name: "a", color: "#112233", pattern: "dots" }, { id: 2, color: "bad" }] });
    expect(tileStyle(10)).toMatchObject({ color: "#112233", pattern: "dots" });
    expect(tileStyle(11).color).toBe(paletteColorForGid(11));
    clearTileset();
  });
});
