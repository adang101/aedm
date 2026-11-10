import { describe, expect, it } from "vitest";
import { BIOMES, MapBriefSchema, MapSchema, SIZE_CLASSES } from "@aedm/schemas";
import type { GameMap, MapBrief } from "@aedm/schemas";
import { legacyInlineTileset } from "./compat";
import {
  STARTER_BRIEFS, TILESET_BLOCKS, distance, findFreeTileNear, findPath, generateMap, getObjects, getSpawn,
  hasLineOfSight, isWalkable, renderAscii, serializeSize, tileInfo, validateMap,
} from "./index";

const SEEDS = Array.from({ length: 20 }, (_, i) => 1000 + i * 7919);

function floodReach(map: GameMap, from: { x: number; y: number }): Set<string> {
  const seen = new Set([`${from.x},${from.y}`]);
  const stack = [from];
  while (stack.length) {
    const p = stack.pop()!;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const x = p.x + dx;
        const y = p.y + dy;
        if (isWalkable(map, x, y) && !seen.has(`${x},${y}`)) {
          seen.add(`${x},${y}`);
          stack.push({ x, y });
        }
      }
  }
  return seen;
}

/** Hand-built 20x20 map: open room with a vertical wall at x=10 from y=2..17. */
function blank(): GameMap {
  const n = 400;
  const walls = new Array<number>(n).fill(0);
  for (let i = 0; i < 20; i++) {
    walls[i] = 29; walls[19 * 20 + i] = 29; walls[i * 20] = 29; walls[i * 20 + 19] = 29;
  }
  const ground = new Array<number>(n).fill(1);
  return {
    v: 2, id: "m_test", width: 20, height: 20, tile_size: 48,
    tileset: legacyInlineTileset(),
    layers: [
      { type: "tilelayer", name: "ground", data: ground },
      { type: "tilelayer", name: "walls", data: walls },
      { type: "tilelayer", name: "decor", data: new Array<number>(n).fill(0) },
      { type: "tilelayer", name: "above", data: new Array<number>(n).fill(0) },
      { type: "objectgroup", name: "objects", objects: [{ type: "spawn", name: "party_start", x: 2, y: 2 }] },
    ],
    meta: { setting: { name: "Test field", preset: "forest", layout: "open_field", environment: "outdoor", mood: "bright" }, theme_tags: [], seed: 1, generated_at: "1970-01-01T00:00:00Z" },
  };
}
const wallsOf = (m: GameMap) => (m.layers[1] as { data: number[] }).data;
const objsOf = (m: GameMap) => getObjects(m);

describe("tileset", () => {
  it("is self-consistent", () => {
    expect(TILESET_BLOCKS.asset_id).toBe("ts_blocks");
    expect(TILESET_BLOCKS.first_gid).toBe(1);
    TILESET_BLOCKS.tiles.forEach((t, i) => {
      expect(t.id).toBe(i + 1);
      expect(t.color).toMatch(/^#[0-9a-f]{6}$/);
      expect(tileInfo(t.id)).toBe(t);
    });
    expect(tileInfo(0)).toBeUndefined();
    for (const b of BIOMES) {
      const of = (layer: string) => TILESET_BLOCKS.tiles.filter((t) => t.biomes.includes(b) && t.layer === layer);
      expect(of("ground").length).toBeGreaterThanOrEqual(3);
      expect(of("walls").length).toBeGreaterThanOrEqual(2);
      expect(of("decor").length).toBeGreaterThanOrEqual(4);
    }
    expect(TILESET_BLOCKS.tiles.filter((t) => t.layer === "walls").every((t) => !t.walkable)).toBe(true);
  });
});

describe("generateMap", () => {
  it("is deterministic and seed-sensitive", () => {
    const b = STARTER_BRIEFS.dungeon;
    const a1 = generateMap(b, { seed: 5, id: "m_a" }).map;
    const a2 = generateMap(b, { seed: 5, id: "m_a" }).map;
    const c = generateMap(b, { seed: 6, id: "m_a" }).map;
    expect(a1).toEqual(a2);
    expect(c).not.toEqual(a1);
    expect(generateMap(b, { seed: 5, id: "m_a", generatedAt: "2026-01-01T00:00:00Z" }).map.meta.generated_at).toBe("2026-01-01T00:00:00Z");
  });

  it("all starter briefs parse", () => {
    for (const b of BIOMES) expect(() => MapBriefSchema.parse(STARTER_BRIEFS[b])).not.toThrow();
  });

  for (const biome of BIOMES) {
    for (const size_class of SIZE_CLASSES) {
      it(`${biome} / ${size_class} x20 seeds`, () => {
        const brief: MapBrief = { ...STARTER_BRIEFS[biome], size_class };
        for (const seed of SEEDS) {
          const { map } = generateMap(brief, { seed, id: "m_x" });
          expect(() => MapSchema.parse(map)).not.toThrow();
          expect(validateMap(map)).toEqual({ ok: true, errors: [] });
          expect(serializeSize(map)).toBeLessThanOrEqual(250 * 1024);
          const [lo, hi] = { small: [20, 30], medium: [30, 45], large: [45, 60] }[size_class] as [number, number];
          expect(map.width).toBeGreaterThanOrEqual(lo);
          expect(map.width).toBeLessThanOrEqual(hi);
          for (const l of map.layers) if (l.type === "tilelayer") expect(l.data.length).toBe(map.width * map.height);
          const start = getSpawn(map, "party_start")!;
          const reach = floodReach(map, start);
          const objs = getObjects(map);
          for (const o of objs) {
            if (o.type === "exit" || o.type === "entity_slot" || o.type === "interactable") {
              expect(reach.has(`${o.x},${o.y}`)).toBe(true);
              if (o.type !== "interactable") {
                const p = findPath(map, start, o, new Set());
                expect(p === null && !(o.x === start.x && o.y === start.y)).toBe(false);
              }
            }
          }
          expect(objs.filter((o) => o.type === "exit").length).toBe(brief.exits.length);
          expect(objs.filter((o) => o.type === "entity_slot").length).toBe(brief.entity_slots.length);
        }
      });
    }
  }

  it("handles the spike lighthouse brief and a marsh forest brief", () => {
    const lighthouse: MapBrief = {
      setting: { name: "Lighthouse", preset: "interior", layout: "rooms_and_corridors", environment: "indoor", mood: "dim" }, theme_tags: ["lighthouse"], size_class: "small",
      rooms: [
        { id: "r1", type: "chamber", size: "medium", connects_to: ["r2"] },
        { id: "r2", type: "corridor", size: "small", connects_to: ["r3", "r4"] },
        { id: "r3", type: "chamber", size: "small", connects_to: [] },
        { id: "r4", type: "chamber", size: "medium", connects_to: ["r5"] },
        { id: "r5", type: "hall", size: "small", connects_to: ["r6"] },
        { id: "r6", type: "chamber", size: "small", connects_to: [] },
      ],
      points_of_interest: [{ kind: "chest", room_id: "r3" }],
      entity_slots: [{ role: "enemy", room_id: "r6", count: 2 }],
      exits: [{ side: "south", label: "Door" }],
    };
    const marsh: MapBrief = { ...STARTER_BRIEFS.forest, theme_tags: ["marsh", "fog"], size_class: "large" };
    for (const seed of SEEDS.slice(0, 8)) {
      for (const b of [lighthouse, marsh]) expect(validateMap(generateMap(b, { seed, id: "m_x" }).map).ok).toBe(true);
    }
  });

  it("copes with 12 rooms on a small map", () => {
    const rooms = Array.from({ length: 12 }, (_, i) => ({
      id: `r${i}`, type: "chamber" as const, size: "large" as const, connects_to: i > 0 ? [`r${i - 1}`] : [],
    }));
    const brief: MapBrief = { ...STARTER_BRIEFS.dungeon, size_class: "small", rooms, points_of_interest: [], entity_slots: [{ role: "enemy", room_id: "r11", count: 2 }] };
    for (const seed of SEEDS.slice(0, 5)) expect(validateMap(generateMap(brief, { seed, id: "m_x" }).map).ok).toBe(true);
  });

  it("places interactables and slots with ids, one object per tile", () => {
    const { map } = generateMap(STARTER_BRIEFS.dungeon, { seed: 3, id: "m_d" });
    const objs = getObjects(map);
    expect(objs.filter((o) => o.type === "entity_slot").map((o) => (o as { id: string }).id)).toEqual(["slot_1", "slot_2", "slot_3"]);
    expect(objs.filter((o) => o.type === "interactable").map((o) => (o as { kind: string }).kind).sort()).toEqual(["altar", "chest", "lever"]);
    expect(new Set(objs.map((o) => `${o.x},${o.y}`)).size).toBe(objs.length);
    expect(objs.filter((o) => o.type === "exit").every((o) => o.type === "exit" && o.to === "pending" && o.target_entry === "party_start")).toBe(true);
  });

  it("throws a descriptive error when every attempt fails", () => {
    const bad = { ...STARTER_BRIEFS.dungeon, exits: [{ side: "north", label: "a" }, { side: "north", label: "b" }, { side: "north", label: "c" }, { side: "north", label: "d" }] } as MapBrief;
    // valid brief should still work with duplicate sides
    expect(() => generateMap(bad, { seed: 1, id: "m_x" })).not.toThrow();
    expect(() => generateMap({ ...bad, rooms: [] } as MapBrief, { seed: 1, id: "m_x" })).toThrow();
  });
});

describe("navigation", () => {
  it("isWalkable respects bounds and the walls layer", () => {
    const m = blank();
    expect(isWalkable(m, 5, 5)).toBe(true);
    expect(isWalkable(m, 0, 5)).toBe(false);
    expect(isWalkable(m, -1, 5)).toBe(false);
    expect(isWalkable(m, 20, 5)).toBe(false);
  });

  it("distance is Chebyshev", () => {
    expect(distance({ x: 1, y: 1 }, { x: 4, y: 3 })).toBe(3);
  });

  it("findPath goes around a wall, excludes start, includes goal", () => {
    const m = blank();
    for (let y = 2; y <= 17; y++) wallsOf(m)[y * 20 + 10] = 29;
    const p = findPath(m, { x: 5, y: 10 }, { x: 15, y: 10 })!;
    expect(p).not.toBeNull();
    expect(p[p.length - 1]).toEqual({ x: 15, y: 10 });
    expect(p[0]).not.toEqual({ x: 5, y: 10 });
    expect(p.every((q) => isWalkable(m, q.x, q.y))).toBe(true);
    expect(p.length).toBeGreaterThan(10);
    expect(findPath(m, { x: 5, y: 10 }, { x: 10, y: 10 })).toBeNull();
    expect(findPath(m, { x: 5, y: 10 }, { x: 5, y: 10 })).toEqual([]);
    expect(findPath(m, { x: 5, y: 10 }, { x: 15, y: 10 }, new Set(["15,10"]))).toBeNull();
  });

  it("findPath does not cut corners and routes around occupied tiles", () => {
    const m = blank();
    wallsOf(m)[5 * 20 + 6] = 29; // (6,5)
    wallsOf(m)[6 * 20 + 5] = 29; // (5,6)
    expect(findPath(m, { x: 5, y: 5 }, { x: 6, y: 6 })!.length).toBeGreaterThan(1);
    const m2 = blank();
    const occ = new Set(["6,5", "6,6", "6,7"]);
    const p = findPath(m2, { x: 5, y: 6 }, { x: 7, y: 6 }, occ)!;
    expect(p.some((q) => occ.has(`${q.x},${q.y}`))).toBe(false);
  });

  it("hasLineOfSight is blocked by walls and blockers but not by endpoints", () => {
    const m = blank();
    expect(hasLineOfSight(m, { x: 2, y: 5 }, { x: 8, y: 5 })).toBe(true);
    wallsOf(m)[5 * 20 + 5] = 29;
    expect(hasLineOfSight(m, { x: 2, y: 5 }, { x: 8, y: 5 })).toBe(false);
    expect(hasLineOfSight(m, { x: 2, y: 5 }, { x: 5, y: 5 })).toBe(true); // wall is the endpoint
    const m2 = blank();
    expect(hasLineOfSight(m2, { x: 2, y: 5 }, { x: 8, y: 5 }, new Set(["5,5"]))).toBe(false);
    expect(hasLineOfSight(m2, { x: 2, y: 5 }, { x: 8, y: 5 }, new Set(["2,5", "8,5"]))).toBe(true);
    expect(hasLineOfSight(m2, { x: 3, y: 3 }, { x: 3, y: 3 })).toBe(true);
  });

  it("findFreeTileNear skips occupied tiles", () => {
    const m = blank();
    expect(findFreeTileNear(m, 5, 5, new Set())).toEqual({ x: 5, y: 5 });
    const occ = new Set<string>();
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) occ.add(`${5 + dx},${5 + dy}`);
    const t = findFreeTileNear(m, 5, 5, occ)!;
    expect(distance(t, { x: 5, y: 5 })).toBe(2);
    expect(occ.has(`${t.x},${t.y}`)).toBe(false);
    expect(findFreeTileNear(m, 99, 99, occ)).toBeNull();
  });

  it("getSpawn / getObjects", () => {
    const m = blank();
    expect(getSpawn(m, "party_start")).toEqual({ x: 2, y: 2 });
    expect(getSpawn(m, "nope")).toBeNull();
    expect(getObjects(m)).toHaveLength(1);
  });
});

describe("validateMap catches each rule", () => {
  const ok = () => {
    const m = blank();
    objsOf(m).push({ type: "exit", name: "e", to: "pending", target_entry: "party_start", x: 19, y: 10 });
    wallsOf(m)[10 * 20 + 19] = 0;
    return m;
  };
  it("accepts a good map", () => expect(validateMap(ok())).toEqual({ ok: true, errors: [] }));

  it("rule 1: data length", () => {
    const m = ok();
    (m.layers[2] as { data: number[] }).data.pop();
    expect(validateMap(m).errors.join()).toContain("rule 1");
  });
  it("rule 2: tile id without a TileDef", () => {
    const m = ok();
    (m.layers[0] as { data: number[] }).data[50] = 9999;
    expect(validateMap(m).errors.join()).toContain("rule 2");
  });
  it("rule 3: party_start in a wall", () => {
    const m = ok();
    wallsOf(m)[2 * 20 + 2] = 29;
    expect(validateMap(m).errors.join()).toContain("rule 3");
  });
  it("rule 4: unreachable slot", () => {
    const m = ok();
    for (let y = 1; y < 19; y++) wallsOf(m)[y * 20 + 10] = 29;
    objsOf(m).push({ type: "entity_slot", id: "slot_1", role: "enemy", count: 1, x: 15, y: 10 });
    expect(validateMap(m).errors.join()).toContain("rule 4");
  });
  it("rule 5: shared tile", () => {
    const m = ok();
    objsOf(m).push({ type: "interactable", id: "c1", kind: "chest", state: "closed", x: 2, y: 2 });
    expect(validateMap(m).errors.join()).toContain("rule 5");
  });
  it("rule 6: exit inside the map and not a door", () => {
    const m = ok();
    objsOf(m).push({ type: "exit", name: "mid", to: "pending", target_entry: "party_start", x: 8, y: 8 });
    expect(validateMap(m).errors.join()).toContain("rule 6");
  });
  it("rule 6: exit on a door tile is fine", () => {
    const m = ok();
    objsOf(m).push({ type: "exit", name: "mid", to: "pending", target_entry: "party_start", x: 8, y: 8 });
    (m.layers[0] as { data: number[] }).data[8 * 20 + 8] = TILESET_BLOCKS.tiles.find((t) => t.name === "door_wood")!.id;
    expect(validateMap(m).ok).toBe(true);
  });
  it("rule 7: too big", () => {
    const m = ok();
    m.meta.theme_tags = ["x".repeat(300 * 1024)];
    expect(validateMap(m).errors.join()).toContain("rule 7");
  });
});

describe("renderAscii", () => {
  it("renders a small generated map (snapshot)", () => {
    const brief: MapBrief = {
      setting: { name: "Crypt", preset: "dungeon", layout: "rooms_and_corridors", environment: "underground", mood: "dark" }, theme_tags: [], size_class: "small",
      rooms: [
        { id: "a", type: "chamber", size: "small", connects_to: ["b"] },
        { id: "b", type: "chamber", size: "small", connects_to: [] },
      ],
      points_of_interest: [{ kind: "chest", room_id: "b" }],
      entity_slots: [{ role: "enemy", room_id: "b", count: 1 }],
      exits: [{ side: "north", label: "Up" }],
    };
    const { map } = generateMap(brief, { seed: 11, id: "m_snap" });
    const art = renderAscii(map);
    expect(art.split("\n")).toHaveLength(map.height);
    expect(art).toMatchSnapshot();
    expect(art).toContain("S");
    expect(art).toContain("E");
    expect(art).toContain("e");
    expect(art).toContain("c");
  });
});

describe("compat shim (legacy tileset as v2)", () => {
  it("legacyInlineTileset mirrors the block tileset gid for gid and parses in a v2 map", () => {
    const ts = legacyInlineTileset();
    expect(ts.first_gid).toBe(1);
    expect(ts.tiles).toHaveLength(TILESET_BLOCKS.tiles.length);
    for (const t of ts.tiles) {
      expect(tileInfo(t.gid)?.name).toBe(t.material_id);
      expect(tileInfo(t.gid)?.walkable).toBe(t.walkable);
    }
    expect(ts.tiles.find((t) => t.material_id === "door_wood")?.role).toBe("door");
    expect(ts.tiles.find((t) => t.material_id === "water")?.role).toBe("liquid");
    expect(ts.tiles.find((t) => t.material_id === "wall_stone")).toMatchObject({ role: "wall", blocks_sight: true });
  });
  it("generated maps are v2 with meta.setting copied from the brief", () => {
    const { map } = generateMap({ ...STARTER_BRIEFS.town, setting: { name: "Gull Harbor", layout: "settlement", environment: "outdoor", mood: "bright" } }, { seed: 5, id: "m_x" });
    expect(map.v).toBe(2);
    expect(map.meta.setting).toEqual({ name: "Gull Harbor", layout: "settlement", environment: "outdoor", mood: "bright" });
    expect(MapSchema.safeParse(map).success).toBe(true);
  });
});
