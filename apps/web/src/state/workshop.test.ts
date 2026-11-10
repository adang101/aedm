import { afterEach, describe, expect, it } from "vitest";
import { PIXEL_COUNT, encodePixels, type CastEntry, type EntityView, type PixelSprite, type SpriteSpec, type WorkshopAsset } from "@aedm/schemas";
import {
  CAST_ROLES, MASK_SPRITE, canOffer, formatBytes, hidePrefs, offerable, resetHidePrefs, savePayload, setEntryHidden, setHidePaintings, shownEntity, shownRecipe, sourceOf,
} from "./workshop";

const spec: SpriteSpec = {
  kind: "spec", v: 1, body: "avian", size: "medium", traits: "", glyph: "H",
  palette: { primary: "#112233", secondary: "#445566", accent: "#778899", detail: "#001122" }, parts: [],
};
const pixel = (base?: SpriteSpec): PixelSprite => ({
  kind: "pixel", v: 1, width: 48, height: 64, palette: ["#1b1626"], pixels: encodePixels(new Uint8Array(PIXEL_COUNT)), size: "medium", traits: "", ...(base ? { base } : {}),
});
const entry = (id: string, recipe: CastEntry["recipe"]): CastEntry => ({ asset_id: id, owner_player_id: "p1", owner_name: "Ana", name: id, role_hint: "npc", concept: "", recipe, status: "approved" });
const view = (sprite: EntityView["sprite"]): EntityView => ({ id: "npc_1", kind: "npc", name: "N", x: 1, y: 1, hp: 1, hp_max: 1, conditions: [], sprite });
const asset = (id: string, role: WorkshopAsset["role_hint"]): WorkshopAsset => ({
  id, name: id, role_hint: role, concept: "", tags: [], recipe: spec, source: "designed", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
});

afterEach(() => { resetHidePrefs(); });

describe("savePayload", () => {
  it("derives the source from the recipe and trims and clips text", () => {
    expect(sourceOf(spec)).toBe("designed");
    expect(sourceOf(pixel())).toBe("painted");
    expect(sourceOf(pixel(spec))).toBe("painted_over");
    const p = savePayload({ name: `  ${"n".repeat(60)} `, role_hint: "npc", concept: "c".repeat(300), recipe: pixel(spec) });
    expect(p.name).toHaveLength(40);
    expect(p.concept).toHaveLength(200);
    expect(p.source).toBe("painted_over");
    expect(p).not.toHaveProperty("id");
    expect(savePayload({ id: "as_1", name: " ", role_hint: "pc", concept: "", recipe: spec }).name).toBe("Untitled");
    expect(savePayload({ id: "as_1", name: "x", role_hint: "pc", concept: "", recipe: spec }).id).toBe("as_1");
  });
});

describe("offering", () => {
  it("only npc and enemy looks that are not already in the cast", () => {
    expect(CAST_ROLES).toEqual(["npc", "enemy"]);
    expect(canOffer(asset("a", "prop"))).toBe(false);
    const list = [asset("a", "npc"), asset("b", "enemy"), asset("c", "pc"), asset("d", "prop"), asset("e", "npc")];
    expect(offerable(list, [entry("e", spec)]).map((a) => a.id)).toEqual(["a", "b"]);
  });
  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(300 * 1024)).toBe("300 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("hiding custom sprites (per viewer)", () => {
  it("shows everything when nothing is hidden", () => {
    const p = pixel();
    expect(shownRecipe(p, [entry("x", p)])).toBe(p);
    const e = view(p);
    expect(shownEntity(e, [])).toBe(e);
  });
  it("hides a cast entry's look wherever it is used, and only that look", () => {
    const hidden = pixel();
    const other = { ...pixel(), palette: ["#c99a63"] };
    const cast = [entry("x", hidden)];
    setEntryHidden("x", true);
    expect(shownRecipe({ ...hidden }, cast)).toBe(MASK_SPRITE);
    expect(shownEntity(view({ ...hidden }), cast).sprite).toBe(MASK_SPRITE);
    expect(shownRecipe(other, cast)).toBe(other);
    setEntryHidden("x", false);
    expect(shownRecipe(hidden, cast)).toBe(hidden);
  });
  it("hide all paintings: painted sprites show their base spec, or the mask; specs are untouched", () => {
    setHidePaintings(true);
    const withBase = pixel(spec);
    expect(shownRecipe(withBase, [])).toBe(spec);
    expect(shownRecipe(pixel(), [])).toBe(MASK_SPRITE);
    expect(shownRecipe(spec, [])).toBe(spec);
  });
  it("persists to localStorage when it exists and works without it", () => {
    const store = new Map<string, string>();
    const g = globalThis as unknown as { localStorage?: unknown };
    const saved = g.localStorage;
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
    try {
      setEntryHidden("as_1", true);
      setHidePaintings(true);
      resetHidePrefs();
      expect(hidePrefs().ids.has("as_1")).toBe(true);
      expect(hidePrefs().paintings).toBe(true);
      store.set("aedm.hidden_cast", "not json");
      resetHidePrefs();
      expect(hidePrefs().ids.size).toBe(0);
    } finally {
      g.localStorage = saved;
    }
    g.localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    try {
      resetHidePrefs();
      expect(() => setEntryHidden("as_2", true)).not.toThrow();
      expect(hidePrefs().ids.has("as_2")).toBe(true);
    } finally {
      g.localStorage = saved;
    }
  });
});
