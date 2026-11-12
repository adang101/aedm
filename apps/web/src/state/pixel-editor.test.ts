import { describe, expect, it } from "vitest";
import { PALETTE_HEX, PIXEL_COUNT, decodePixels, type SpriteSpec } from "@aedm/schemas";
import {
  H, MAX_UNDO, W, blank, checkImage, clampZoom, colorCount, colorId, commit, createEditor, fillMirrored, floodFill, fromRecipe, fromRgba,
  lineCells, paintCells, pick, rectCells, redo, toRecipe, toolForKey, undo, withMirror,
} from "./pixel-editor";

const at = (x: number, y: number) => y * W + x;

describe("history", () => {
  it("undoes and redoes a commit", () => {
    let s = createEditor();
    s = commit(s, paintCells(s.px, [[5, 5]], 3));
    expect(pick(s.px, 5, 5)).toBe(3);
    s = undo(s);
    expect(pick(s.px, 5, 5)).toBe(0);
    s = redo(s);
    expect(pick(s.px, 5, 5)).toBe(3);
  });
  it("a new commit clears redo, an unchanged one is not a step", () => {
    let s = createEditor();
    s = commit(s, paintCells(s.px, [[1, 1]], 2));
    s = undo(s);
    s = commit(s, paintCells(s.px, [[2, 2]], 2));
    expect(s.future).toHaveLength(0);
    const same = commit(s, s.px.slice());
    expect(same).toBe(s);
  });
  it("keeps at most 50 steps", () => {
    let s = createEditor();
    for (let i = 0; i < 60; i++) s = commit(s, paintCells(s.px, [[i % W, 10]], (i % 2) + 1 + (i > 30 ? 2 : 0)));
    expect(s.past.length).toBe(MAX_UNDO);
    for (let i = 0; i < 100; i++) s = undo(s);
    expect(s.past).toHaveLength(0);
  });
  it("undo and redo on empty history do nothing", () => {
    const s = createEditor();
    expect(undo(s)).toBe(s);
    expect(redo(s)).toBe(s);
  });
});

describe("shapes", () => {
  it("draws a diagonal, horizontal and single-point line", () => {
    expect(lineCells(0, 0, 3, 3)).toEqual([[0, 0], [1, 1], [2, 2], [3, 3]]);
    expect(lineCells(4, 2, 1, 2)).toEqual([[4, 2], [3, 2], [2, 2], [1, 2]]);
    expect(lineCells(7, 7, 7, 7)).toEqual([[7, 7]]);
  });
  it("lines reach the end point from any direction", () => {
    for (const [x1, y1] of [[10, 3], [2, 9], [-5, 4], [6, -8]] as const) {
      const c = lineCells(0, 0, x1, y1);
      expect(c[c.length - 1]).toEqual([x1, y1]);
    }
  });
  it("rect: filled and outline, corners in any order", () => {
    expect(rectCells(3, 3, 1, 1, true)).toHaveLength(9);
    expect(rectCells(1, 1, 3, 3, false)).toHaveLength(8);
    expect(rectCells(1, 1, 1, 1, false)).toEqual([[1, 1]]);
  });
  it("mirror adds the cell on the opposite side", () => {
    expect(withMirror([[2, 5]], true)).toEqual([[2, 5], [45, 5]]);
    expect(withMirror([[2, 5]], false)).toEqual([[2, 5]]);
    const px = paintCells(blank(), withMirror([[0, 0], [10, 20]], true), 4);
    expect(pick(px, 47, 0)).toBe(4);
    expect(pick(px, 37, 20)).toBe(4);
  });
  it("paintCells ignores cells out of bounds", () => {
    const px = paintCells(blank(), [[-1, 0], [0, -1], [48, 0], [0, 64], [1, 1]], 2);
    expect(px.reduce((a, v) => a + (v ? 1 : 0), 0)).toBe(1);
  });
});

describe("fill", () => {
  it("fills a bounded region only", () => {
    let px = paintCells(blank(), rectCells(10, 10, 20, 20, false), 1);
    px = floodFill(px, 15, 15, 2);
    expect(pick(px, 15, 15)).toBe(2);
    expect(pick(px, 11, 11)).toBe(2);
    expect(pick(px, 10, 10)).toBe(1);
    expect(pick(px, 5, 5)).toBe(0);
  });
  it("is 4-connected: a diagonal gap holds", () => {
    let px = paintCells(blank(), [[1, 0], [0, 1]], 1);
    px = floodFill(px, 0, 0, 2);
    expect(pick(px, 1, 1)).toBe(0);
    expect(pick(px, 0, 0)).toBe(2);
  });
  it("fills the whole canvas when empty, and no-ops on the same color or out of bounds", () => {
    const px = floodFill(blank(), 0, 0, 5);
    expect(px.every((v) => v === 5)).toBe(true);
    expect(floodFill(px, 3, 3, 5)).toBe(px);
    expect(floodFill(px, -1, 3, 1)).toBe(px);
  });
  it("mirrored fill reaches both sides of a wall", () => {
    let px = paintCells(blank(), Array.from({ length: H }, (_, y): [number, number] => [24, y]), 1);
    px = paintCells(px, Array.from({ length: H }, (_, y): [number, number] => [23, y]), 1);
    px = fillMirrored(px, 5, 5, 2, true);
    expect(pick(px, 40, 40)).toBe(2);
    expect(pick(px, 10, 10)).toBe(2);
  });
});

describe("misc", () => {
  it("zoom clamps to 4..12", () => {
    expect(clampZoom(1)).toBe(4);
    expect(clampZoom(99)).toBe(12);
    expect(clampZoom(7.4)).toBe(7);
  });
  it("shortcuts", () => {
    expect(toolForKey("b")).toBe("pencil");
    expect(toolForKey("E")).toBe("eraser");
    expect(toolForKey("g")).toBe("fill");
    expect(toolForKey("i")).toBe("eyedropper");
    expect(toolForKey("z")).toBeUndefined();
  });
});

describe("conversion", () => {
  const body = () => paintCells(blank(), rectCells(16, 10, 31, 60, true), colorId(PALETTE_HEX[5]!));
  it("round-trips through the recipe", () => {
    const px = paintCells(body(), [[20, 20], [21, 20]], colorId(PALETTE_HEX[32]!));
    const r = toRecipe(px, { size: "large" });
    expect(r.size).toBe("large");
    expect(r.palette).toHaveLength(2);
    expect(fromRecipe(r)).toEqual(px);
    expect(decodePixels(r.pixels)).toHaveLength(PIXEL_COUNT);
  });
  it("snaps rgba to the master palette and treats low alpha as transparent", () => {
    const d = new Uint8ClampedArray(PIXEL_COUNT * 4);
    d.set([0x2f, 0x5d, 0x34, 255], 0);
    d.set([0x30, 0x5c, 0x35, 255], 4);
    d.set([255, 0, 0, 100], 8);
    const px = fromRgba(d);
    expect(px[0]).toBe(colorId("#2f5d34"));
    expect(px[1]).toBe(colorId("#2f5d34"));
    expect(px[2]).toBe(0);
    expect(colorCount(px)).toBe(1);
  });
  it("a good image checks out; an empty one does not", () => {
    expect(checkImage(body(), { size: "medium" }).ok).toBe(true);
    const c = checkImage(blank(), { size: "medium" });
    expect(c.ok).toBe(false);
    expect(c.issues.map((i) => i.code)).toContain("opaque");
  });
  it("shifts the feet and reports it", () => {
    const px = paintCells(blank(), rectCells(16, 10, 31, 40, true), 3);
    const c = checkImage(px, { size: "medium" });
    expect(c.ok).toBe(true);
    expect(c.shifted).toBe(20);
  });
  it("reports too many colors without encoding", () => {
    const px = blank();
    for (let i = 0; i < 33; i++) px[at(10 + (i % 20), 20 + ((i / 20) | 0))] = i + 1;
    const c = checkImage(px, { size: "medium" });
    expect(c.ok).toBe(false);
    expect(c.issues[0]?.code).toBe("colors");
    expect(c.colors).toBe(33);
  });
  it("keeps the base spec", () => {
    const base: SpriteSpec = { kind: "spec", v: 1, body: "humanoid", size: "medium", traits: "tall", palette: { primary: "#3d2a6b", secondary: "#6a45a8", accent: "#cbb0f0", detail: "#1b1626" }, parts: [] };
    const r = toRecipe(body(), { size: "medium", base });
    expect(r.base).toEqual(base);
    expect(r.traits).toBe("tall");
  });
});
