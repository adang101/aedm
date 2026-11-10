import { describe, expect, it } from "vitest";
import { makeMap } from "./fixtures/map";
import { MapBriefSchema, MapSchema } from "./map";

const brief = {
  biome: "interior", theme_tags: ["lighthouse", "damp"], size_class: "small",
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
    expect(MapBriefSchema.safeParse({ ...brief, biome: "swamp" }).success).toBe(false);
    expect(MapBriefSchema.safeParse({ ...brief, exits: [] }).success).toBe(false);
    expect(MapBriefSchema.safeParse({ ...brief, theme_tags: ["a", "b", "c", "d", "e"] }).success).toBe(false);
    expect(MapBriefSchema.safeParse({ ...brief, entity_slots: [{ role: "enemy", room_id: "zz", count: 1 }] }).success).toBe(false);
    expect(MapBriefSchema.safeParse({ ...brief, entity_slots: [{ role: "enemy", room_id: "r1", count: 7 }] }).success).toBe(false);
    expect(MapBriefSchema.safeParse({ ...brief, rooms: [brief.rooms[0], brief.rooms[0]] }).success).toBe(false);
    expect(MapBriefSchema.safeParse({ ...brief, extra: 1 }).success).toBe(false);
  });
});

describe("Map", () => {
  it("parses a valid map", () => {
    const r = MapSchema.safeParse(makeMap());
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
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
