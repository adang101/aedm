import { describe, expect, it } from "vitest";
import { makeMap } from "./fixtures/map";
import { MapBriefSchema, MapSchema } from "./map";
import { SETTING_PRESETS } from "./enums";

const brief = {
  setting: { name: "Lighthouse interior", preset: "interior", layout: "rooms_and_corridors", environment: "indoor", mood: "dim" },
  theme_tags: ["lighthouse", "damp"], size_class: "small",
  rooms: [
    { id: "r1", type: "hall", size: "small", connects_to: ["r2"] },
    { id: "r2", type: "chamber", size: "medium", connects_to: ["r1"] },
  ],
  points_of_interest: [{ kind: "desk", room_id: "r2" }],
  entity_slots: [{ role: "enemy", room_id: "r2", count: 2 }],
  exits: [{ side: "south", label: "Lighthouse door" }],
};

describe("MapBrief", () => {
  it("parses", () => expect(MapBriefSchema.safeParse(brief).success).toBe(true));
  it("rejects bad references and limits", () => {
    expect(MapBriefSchema.safeParse({ ...brief, setting: { ...brief.setting, layout: "spiral" } }).success).toBe(false);
    expect(MapBriefSchema.safeParse({ ...brief, setting: { ...brief.setting, preset: "moon_base" } }).success).toBe(false);
    expect(MapBriefSchema.safeParse({ ...brief, biome: "swamp" }).success).toBe(false);
    expect(MapBriefSchema.safeParse({ ...brief, exits: [] }).success).toBe(false);
    expect(MapBriefSchema.safeParse({ ...brief, theme_tags: ["a", "b", "c", "d", "e"] }).success).toBe(false);
    expect(MapBriefSchema.safeParse({ ...brief, entity_slots: [{ role: "enemy", room_id: "zz", count: 1 }] }).success).toBe(false);
    expect(MapBriefSchema.safeParse({ ...brief, entity_slots: [{ role: "enemy", room_id: "r1", count: 7 }] }).success).toBe(false);
    expect(MapBriefSchema.safeParse({ ...brief, rooms: [brief.rooms[0], brief.rooms[0]] }).success).toBe(false);
    expect(MapBriefSchema.safeParse({ ...brief, extra: 1 }).success).toBe(false);
  });
});

describe("MapBrief v2 setting", () => {
  const { preset: _p, ...noPreset } = brief.setting;
  it("accepts a preset-only brief (no materials, no density)", () => {
    expect(MapBriefSchema.safeParse(brief).success).toBe(true);
  });
  it("requires layout and environment, preset optional", () => {
    const { layout: _l, ...noLayout } = brief.setting;
    const { environment: _e, ...noEnv } = brief.setting;
    expect(MapBriefSchema.safeParse({ ...brief, setting: noPreset }).success).toBe(true);
    expect(MapBriefSchema.safeParse({ ...brief, setting: noLayout }).success).toBe(false);
    expect(MapBriefSchema.safeParse({ ...brief, setting: noEnv }).success).toBe(false);
  });
  it("accepts every preset and a free-text name up to 40 chars", () => {
    for (const preset of SETTING_PRESETS) {
      expect(MapBriefSchema.safeParse({ ...brief, setting: { ...brief.setting, preset } }).success, preset).toBe(true);
    }
    expect(MapBriefSchema.safeParse({ ...brief, setting: { ...brief.setting, name: "x".repeat(41) } }).success).toBe(false);
  });
  it("accepts a custom-material brief mixing ids and drafts", () => {
    const custom = {
      ...brief,
      setting: {
        name: "Sunken cathedral", layout: "rooms_and_corridors", environment: "underground", mood: "eerie",
        materials: {
          floor: ["stone_floor", { name: "Drowned tile", role: "floor", color: "#123456", pattern: "tiles" }],
          liquid: [{ id: "black_water", name: "Black water", role: "liquid", color: "#101030" }],
          hazard: [{ name: "Brine vent", role: "hazard", color: "#4f9fe0", hazard: { damage_type: "cold", dice: "1d6" } }],
          decor: ["pew", "candle"],
        },
        density: { obstacles: 1, liquid: 2, hazards: 1 },
      },
    };
    const r = MapBriefSchema.safeParse(custom);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
  it("rejects too many materials, bad density and a hazard on a non-hazard draft", () => {
    const mk = (materials: unknown, density?: unknown) => MapBriefSchema.safeParse({ ...brief, setting: { ...brief.setting, materials, ...(density ? { density } : {}) } }).success;
    expect(mk({ floor: ["a", "b", "c", "d"] })).toBe(false);
    expect(mk({ decor: ["a", "b", "c", "d", "e", "f", "g"] })).toBe(false);
    expect(mk({ floor: ["Bad Id"] })).toBe(false);
    expect(mk({ floor: ["a"] }, { obstacles: 4, liquid: 0, hazards: 0 })).toBe(false);
    expect(mk({ floor: [{ name: "x", role: "floor", color: "#112233", hazard: { damage_type: "fire", dice: "1d4" } }] })).toBe(false);
  });
  it("points_of_interest kind is free text up to 24 chars", () => {
    const poi = (kind: string) => MapBriefSchema.safeParse({ ...brief, points_of_interest: [{ kind, room_id: "r2" }] }).success;
    expect(poi("drowned pipe organ")).toBe(true);
    expect(poi("x".repeat(25))).toBe(false);
  });
});

describe("Map", () => {
  it("parses a valid map", () => {
    const r = MapSchema.safeParse(makeMap());
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
  it("is v2 with an inline tileset and meta.setting", () => {
    const m = makeMap();
    expect(m.v).toBe(2);
    expect(MapSchema.safeParse({ ...m, v: 1 }).success).toBe(false);
    const { tileset: _t, ...noTileset } = m;
    expect(MapSchema.safeParse(noTileset).success).toBe(false);
    expect(MapSchema.safeParse({ ...m, tilesets: [{ asset_id: "ts_x", first_gid: 1 }] }).success).toBe(false);
    expect(MapSchema.safeParse({ ...m, meta: { ...m.meta, biome: "forest" } }).success).toBe(false);
  });
  it("every non-zero gid needs a TileDef", () => {
    const m = makeMap();
    (m.layers[1] as { data: number[] }).data[0] = 1; // wall tile that exists
    (m.layers[0] as { data: number[] }).data[5] = 2;
    expect(MapSchema.safeParse(m).success).toBe(true);
    (m.layers[2] as { data: number[] }).data[7] = 99;
    const r = MapSchema.safeParse(m);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("without a TileDef");
  });
  it("tileset gids are unique, first_gid is 1, variant 0 to 3, colors are hex", () => {
    const dup = makeMap();
    dup.tileset.tiles.push({ ...dup.tileset.tiles[0]! });
    expect(MapSchema.safeParse(dup).success).toBe(false);
    const fg = makeMap();
    expect(MapSchema.safeParse({ ...fg, tileset: { ...fg.tileset, first_gid: 2 } }).success).toBe(false);
    const v = makeMap();
    (v.tileset.tiles[0] as { variant: number }).variant = 4;
    expect(MapSchema.safeParse(v).success).toBe(false);
    const c = makeMap();
    (c.tileset.tiles[0] as { color: string }).color = "gray";
    expect(MapSchema.safeParse(c).success).toBe(false);
    const p = makeMap();
    (p.tileset.tiles[0] as { pattern: string }).pattern = "zigzag";
    expect(MapSchema.safeParse(p).success).toBe(false);
  });
  it("data length must equal w*h", () => {
    const m = makeMap();
    (m.layers[0] as { data: number[] }).data.pop();
    expect(MapSchema.safeParse(m).success).toBe(false);
  });
  it("size, tile_size, ids", () => {
    expect(MapSchema.safeParse(makeMap(19, 20)).success).toBe(false);
    expect(MapSchema.safeParse({ ...makeMap(), tile_size: 32 }).success).toBe(false);
    expect(MapSchema.safeParse({ ...makeMap(), id: "lighthouse" }).success).toBe(false);
  });
  it("needs exactly one party_start and all layers", () => {
    const m = makeMap();
    const objs = (m.layers[4] as { objects: unknown[] }).objects;
    objs.shift();
    expect(MapSchema.safeParse(m).success).toBe(false);
    const m2 = makeMap();
    m2.layers.pop();
    expect(MapSchema.safeParse(m2).success).toBe(false);
  });
  it("objects must be in bounds and have known type", () => {
    const m = makeMap();
    (m.layers[4] as { objects: unknown[] }).objects.push({ type: "spawn", name: "x", x: 20, y: 0 });
    expect(MapSchema.safeParse(m).success).toBe(false);
    const m2 = makeMap();
    (m2.layers[4] as { objects: unknown[] }).objects.push({ type: "portal", x: 1, y: 1 });
    expect(MapSchema.safeParse(m2).success).toBe(false);
  });
});
