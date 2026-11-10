import { describe, expect, it } from "vitest";
import {
  ENVIRONMENTS, LAYOUTS, MOODS, ROOM_TYPES, SETTING_PRESETS, SIZES, SIZE_CLASSES, MapBriefSchema, MapSchema, MATERIAL_ROLES,
} from "@aedm/schemas";
import type { GameMap, InlineTileset, Layout, MapBrief, MaterialRole } from "@aedm/schemas";
import {
  STARTER_BRIEFS, distance, findFreeTileNear, findPath, generateMap, getObjects, getSpawn, hasLineOfSight, isWalkable, renderAscii,
  serializeSize, stripOrphanTiles, validateMap,
} from "./index";
import { MATERIAL_IDS } from "./materials";
import { MapRng } from "./prng";

const SEEDS = [11, 4242, 90001, 31337, 777777];
const BYTES = 250 * 1024;

const defs = (m: GameMap) => new Map(m.tileset.tiles.map((t) => [t.gid, t]));
const layer = (m: GameMap, name: string): number[] => {
  const l = m.layers.find((x) => x.type === "tilelayer" && x.name === name);
  return l && l.type === "tilelayer" ? l.data : [];
};

/** Independent check of the whole contract on a generated map (4-direction flood, so stricter than rule 4). */
function checkMap(map: GameMap, brief: MapBrief, parse = true, exact = true): void {
  if (parse) expect(MapSchema.safeParse(map).success).toBe(true);
  const v = validateMap(map);
  expect(v.errors).toEqual([]);
  expect(v.warnings).toEqual([]); // no orphan tile definitions
  const [lo, hi] = { small: [20, 30], medium: [30, 45], large: [45, 60] }[brief.size_class] as [number, number];
  expect(map.width).toBeGreaterThanOrEqual(lo);
  expect(map.width).toBeLessThanOrEqual(hi);
  expect(map.tileset.tiles.length).toBeLessThanOrEqual(256);
  const ground = layer(map, "ground");
  const start = getSpawn(map, "party_start")!;
  // flood from the start through walkable tiles that are not hazards (4 directions, so stricter than rule 4)
  const { width: w, height: h } = map;
  const wallData = layer(map, "walls");
  const hazard = new Set(map.tileset.tiles.filter((t) => t.role === "hazard").map((t) => t.gid));
  const seen = new Uint8Array(w * h);
  const stack = [start.y * w + start.x];
  seen[stack[0]!] = 1;
  while (stack.length) {
    const c = stack.pop()!;
    const x = c % w;
    const y = (c - x) / w;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const i = ny * w + nx;
      if (seen[i] || wallData[i] !== 0 || hazard.has(ground[i]!)) continue;
      seen[i] = 1;
      stack.push(i);
    }
  }
  const objs = getObjects(map);
  for (const o of objs) {
    if (o.type === "exit" || o.type === "entity_slot" || o.type === "interactable") {
      expect(seen[o.y * w + o.x], `${o.type} at ${o.x},${o.y} reachable without hazards`).toBe(1);
    }
  }
  if (exact) expect(objs.filter((o) => o.type === "exit").length).toBe(brief.exits.length);
  expect(new Set(objs.map((o) => `${o.x},${o.y}`)).size).toBe(objs.length);
  // collision comes only from the walls layer, and TileDefs agree with their layer
  for (const t of map.tileset.tiles) expect(t.walkable).toBe(t.layer !== "walls");
}

function brief(over: Partial<MapBrief> = {}): MapBrief {
  return { ...STARTER_BRIEFS.dungeon, ...over };
}

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

  it("records the setting on the map as the brief gave it", () => {
    const { map } = generateMap({ ...STARTER_BRIEFS.town, setting: { name: "Gull Harbor", layout: "settlement", environment: "outdoor", mood: "bright" } }, { seed: 5, id: "m_x" });
    expect(map.v).toBe(2);
    expect(map.meta.setting).toEqual({ name: "Gull Harbor", layout: "settlement", environment: "outdoor", mood: "bright" });
    expect(map.meta.seed).toBe(5);
  });

  it("has one starter brief per preset, and each parses and generates first try", () => {
    expect(Object.keys(STARTER_BRIEFS).sort()).toEqual([...SETTING_PRESETS].sort());
    for (const p of SETTING_PRESETS) {
      expect(() => MapBriefSchema.parse(STARTER_BRIEFS[p])).not.toThrow();
      expect(STARTER_BRIEFS[p].setting.preset).toBe(p);
      expect(generateMap(STARTER_BRIEFS[p], { seed: 3, id: "m_x" }).attempts).toBe(1);
    }
  });

  describe("every preset x size class x 5 seeds", () => {
    for (const preset of SETTING_PRESETS) {
      it(preset, () => {
        for (const size_class of SIZE_CLASSES) {
          const b: MapBrief = { ...STARTER_BRIEFS[preset], size_class };
          for (const seed of SEEDS) checkMap(generateMap(b, { seed, id: "m_x" }).map, b, seed === SEEDS[0]);
        }
      });
    }
  });

  describe("every layout x environment x 5 seeds", () => {
    for (const layout of LAYOUTS) {
      it(layout, () => {
        for (const environment of ENVIRONMENTS) {
          for (const size_class of ["small", "large"] as const) {
            const b: MapBrief = brief({ setting: { name: "Test place", layout, environment, mood: "neutral" }, size_class });
            for (const seed of SEEDS) {
              const { map, attempts } = generateMap(b, { seed, id: "m_x" });
              checkMap(map, b, seed === SEEDS[0]);
              expect(attempts, `${layout}/${environment}/${size_class}/${seed} needed a fallback`).toBeLessThanOrEqual(3);
            }
          }
        }
      });
    }
  });

  it("stays far under the 250 KB limit, even for large maps", () => {
    let biggest = 0;
    for (const p of SETTING_PRESETS) {
      const { map } = generateMap({ ...STARTER_BRIEFS[p], size_class: "large" }, { seed: 99, id: "m_x" });
      biggest = Math.max(biggest, serializeSize(map));
    }
    expect(biggest).toBeLessThanOrEqual(BYTES);
    expect(biggest).toBeLessThan(150 * 1024);
  });

  it("builds the layouts it names (structure checks)", () => {
    const at = (layout: Layout, environment: "indoor" | "outdoor" | "underground", seed = 8) => {
      const b = brief({ setting: { name: "Test place", layout, environment, mood: "neutral", density: { obstacles: 2, liquid: 2, hazards: 1 } }, size_class: "medium" });
      return generateMap(b, { seed, id: "m_x" }).map;
    };
    const counts = (m: GameMap) => {
      const d = defs(m);
      const tally: Record<string, number> = {};
      for (const name of ["ground", "walls"]) for (const g of layer(m, name)) if (g) tally[d.get(g)!.role] = (tally[d.get(g)!.role] ?? 0) + 1;
      return tally;
    };
    expect(counts(at("islands", "outdoor")).liquid).toBeGreaterThan(300);
    expect(counts(at("islands", "outdoor")).path).toBeGreaterThan(0);
    expect(counts(at("settlement", "outdoor")).wall).toBeGreaterThan(30);
    expect(counts(at("settlement", "outdoor")).door).toBeGreaterThan(0);
    expect(counts(at("cave", "underground")).wall).toBeGreaterThan(200);
    expect(counts(at("maze", "indoor")).wall).toBeGreaterThan(300);
    expect(counts(at("trail", "outdoor")).obstacle).toBeGreaterThan(400);
    expect(counts(at("open_field", "outdoor")).obstacle).toBeGreaterThan(50);
    expect(counts(at("rooms_and_corridors", "indoor")).door).toBeGreaterThan(0);
    // indoor and underground maps are walled at the edge, outdoor open ones end in obstacles
    const edge = (m: GameMap, role: string) => {
      const d = defs(m);
      const w = layer(m, "walls");
      let n = 0;
      for (let x = 0; x < m.width; x++) if (d.get(w[x] ?? 0)?.role === role) n++;
      return n;
    };
    expect(edge(at("rooms_and_corridors", "indoor"), "wall")).toBeGreaterThan(10);
    expect(edge(at("open_field", "outdoor"), "obstacle")).toBeGreaterThan(10);
  });

  it("scales obstacles, liquid and hazards with density 0 to 3", () => {
    const run = (d: number) => {
      let obstacle = 0;
      let liquid = 0;
      let hazard = 0;
      for (const seed of SEEDS) {
        const b = brief({ setting: { name: "Test field", preset: "forest", layout: "open_field", environment: "outdoor", mood: "neutral", density: { obstacles: d, liquid: d, hazards: d } }, size_class: "medium" });
        const m = generateMap(b, { seed, id: "m_x" }).map;
        const t = defs(m);
        for (const g of layer(m, "walls")) {
          const r = t.get(g)?.role;
          if (r === "obstacle") obstacle++;
          if (r === "liquid") liquid++;
        }
        for (const g of layer(m, "ground")) if (t.get(g)?.role === "hazard") hazard++;
      }
      return { obstacle, liquid, hazard };
    };
    const [d0, d1, d2, d3] = [run(0), run(1), run(2), run(3)] as const;
    // the border of an outdoor map is always obstacle; liquid and hazards are zero at density 0
    expect(d0.liquid).toBe(0);
    expect(d0.hazard).toBe(0);
    expect(d3.obstacle).toBeGreaterThan(d1.obstacle);
    expect(d1.obstacle).toBeGreaterThan(d0.obstacle);
    expect(d3.liquid).toBeGreaterThan(d1.liquid);
    expect(d3.hazard).toBeGreaterThan(d1.hazard);
    expect(d2.obstacle).toBeGreaterThan(d0.obstacle);
  });

  describe("free-text settings with no preset", () => {
    const base = (name: string, layout: Layout, environment: "indoor" | "outdoor" | "underground", mood: "bright" | "dark" | "eerie" | "dim" | "neutral", extra = {}): MapBrief =>
      brief({ setting: { name, layout, environment, mood, ...extra }, size_class: "medium", theme_tags: [] });
    const cases: Array<[string, MapBrief]> = [
      ["airship deck in a storm", base("airship deck in a storm", "arena", "outdoor", "dim")],
      ["glacier rift", base("glacier rift", "trail", "outdoor", "bright")],
      ["clockwork foundry", base("clockwork foundry", "rooms_and_corridors", "indoor", "dark")],
      ["candy forest", base("candy forest", "open_field", "outdoor", "bright", {
        materials: {
          floor: [{ name: "Gumdrop moss", role: "floor", color: "#ff77aa", pattern: "polka dots", tags: ["sweet"], prompt_traits: "pink sugar moss" }],
          obstacle: [{ name: "Lollipop tree", role: "obstacle", color: "#f5a65b", accent: "#c0392b", pattern: "swirl", tags: ["tree", "sweet"], prompt_traits: "swirled candy tree" }],
          decor: [{ name: "Sprinkle pile", role: "decor", color: "#cbb0f0", pattern: "sprinkles", tags: [], prompt_traits: "" }],
        },
      })],
    ];
    const sets = new Map<string, string>();
    for (const [name, b] of cases) {
      it(name, () => {
        for (const seed of SEEDS) checkMap(generateMap(b, { seed, id: "m_x" }).map, b, seed === SEEDS[0]);
        const m = generateMap(b, { seed: 1, id: "m_x" }).map;
        sets.set(name, [...new Set(m.tileset.tiles.map((t) => t.material_id))].sort().join());
        expect(m.meta.setting.name).toBe(name);
        expect(m.meta.setting.preset).toBeUndefined();
      });
    }
    it("look visibly different and keep custom materials", () => {
      expect(new Set(sets.values()).size).toBe(cases.length);
      const candy = generateMap(cases[3]![1], { seed: 1, id: "m_x" }).map;
      const ids = candy.tileset.tiles.map((t) => t.material_id);
      expect(ids).toContain("custom_gumdrop_moss");
      expect(ids).toContain("custom_lollipop_tree");
      expect(ids).toContain("custom_lollipop_tree_canopy");
      const tile = candy.tileset.tiles.find((t) => t.material_id === "custom_gumdrop_moss" && t.variant === 0)!;
      expect(tile).toMatchObject({ pattern: "dots", role: "floor", layer: "ground" });
      // the clockwork foundry is full of machinery, the airship has a sea of cloud, the glacier snow and ice
      expect(sets.get("clockwork foundry")).toContain("iron_machinery");
      expect(sets.get("airship deck in a storm")).toContain("hull_planks");
      expect(sets.get("glacier rift")).toMatch(/snow|ice/);
    });
  });

  it("turns points of interest into interactables, library props or custom props", () => {
    const b = brief({
      points_of_interest: [
        { kind: "chest", room_id: "vault" }, { kind: "altar", room_id: "main" }, { kind: "lever", room_id: "hall" }, { kind: "signpost", room_id: "entry" },
        { kind: "fountain", room_id: "hall" }, { kind: "drowned pipe organ", room_id: "main" }, { kind: "ancient statue", room_id: "entry" },
      ],
    });
    const { map } = generateMap(b, { seed: 3, id: "m_x" });
    const objs = getObjects(map);
    expect(objs.filter((o) => o.type === "interactable").map((o) => (o as { kind: string }).kind).sort()).toEqual(["altar", "chest", "lever", "sign"]);
    const ids = map.tileset.tiles.filter((t) => t.layer === "decor").map((t) => t.material_id);
    expect(ids).toContain("fountain");
    expect(ids).toContain("statue");
    expect(ids).toContain("custom_drowned_pipe_organ");
    expect(ids).toContain("treasure_chest");
    const organ = map.tileset.tiles.find((t) => t.material_id === "custom_drowned_pipe_organ")!;
    expect(organ).toMatchObject({ role: "decor", layer: "decor", walkable: true });
    checkMap(map, b);
  });

  it("places interactables and slots with ids, one object per tile", () => {
    const { map } = generateMap(STARTER_BRIEFS.dungeon, { seed: 3, id: "m_d" });
    const objs = getObjects(map);
    expect(objs.filter((o) => o.type === "entity_slot").map((o) => (o as { id: string }).id)).toEqual(["slot_1", "slot_2", "slot_3"]);
    expect(objs.filter((o) => o.type === "interactable").map((o) => (o as { kind: string }).kind).sort()).toEqual(["altar", "chest", "lever"]);
    expect(objs.filter((o) => o.type === "exit").every((o) => o.type === "exit" && o.to === "pending" && o.target_entry === "party_start")).toBe(true);
    expect(objs[0]).toMatchObject({ type: "spawn", name: "party_start" });
  });

  it("keeps hazards off the only way through", () => {
    let hazards = 0;
    for (const layout of LAYOUTS) {
      for (const seed of SEEDS) {
        const b = brief({ setting: { name: "Trap place", layout, environment: layout === "trail" ? "outdoor" : "underground", mood: "dark", density: { obstacles: 1, liquid: 0, hazards: 3 } } });
        const { map } = generateMap(b, { seed, id: "m_x" });
        checkMap(map, b, false);
        const d = defs(map);
        for (const g of layer(map, "ground")) if (d.get(g)?.role === "hazard") hazards++;
      }
    }
    expect(hazards).toBeGreaterThan(40);
  });

  it("hazard materials carry damage info through the library", () => {
    const { map } = generateMap(STARTER_BRIEFS.volcanic, { seed: 5, id: "m_x" });
    const haz = map.tileset.tiles.filter((t) => t.role === "hazard");
    expect(haz.length).toBeGreaterThan(0);
    expect(haz.every((t) => t.layer === "ground" && t.walkable)).toBe(true);
  });

  it("uses up to 3 variants and keeps every tile palette-coherent", () => {
    const { map } = generateMap(STARTER_BRIEFS.forest, { seed: 5, id: "m_x" });
    const floor = map.tileset.tiles.filter((t) => t.role === "floor");
    expect(new Set(floor.map((t) => t.variant)).size).toBeGreaterThanOrEqual(2);
    for (const t of map.tileset.tiles) expect(t.variant).toBeLessThanOrEqual(3);
    expect(map.tileset.tiles.map((t) => t.gid)).toEqual(map.tileset.tiles.map((_, i) => i + 1));
  });

  it("falls back instead of throwing: 12 large rooms in a small arena, a maze or islands", () => {
    const rooms = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, type: "chamber" as const, size: "large" as const, connects_to: i > 0 ? [`r${i - 1}`] : [] }));
    for (const layout of ["arena", "maze", "islands", "rooms_and_corridors", "trail", "settlement", "cave", "open_field"] as const) {
      const b = brief({ setting: { name: "Crowded", layout, environment: "indoor", mood: "neutral" }, size_class: "small", rooms, points_of_interest: [], entity_slots: [{ role: "enemy", room_id: "r11", count: 2 }] });
      for (const seed of SEEDS.slice(0, 3)) checkMap(generateMap(b, { seed, id: "m_x" }).map, b, false);
    }
  });

  it("rejects a brief that does not match the schema", () => {
    expect(() => generateMap({ ...STARTER_BRIEFS.dungeon, rooms: [] } as MapBrief, { seed: 1, id: "m_x" })).toThrow();
    expect(() => generateMap({ ...STARTER_BRIEFS.dungeon, exits: [] } as MapBrief, { seed: 1, id: "m_x" })).toThrow();
  });

  it("copes with exits all on one side", () => {
    const b = brief({ exits: ["a", "b", "c", "d"].map((label) => ({ side: "north" as const, label })) });
    for (const layout of LAYOUTS) {
      const m = generateMap({ ...b, setting: { ...b.setting, layout } }, { seed: 4, id: "m_x" }).map;
      expect(getObjects(m).filter((o) => o.type === "exit")).toHaveLength(4);
    }
  });
});

// ---------- fuzz ----------

function randomBrief(r: MapRng): MapBrief {
  const n = r.int(1, 12);
  const ids = Array.from({ length: n }, (_, i) => `room_${i}`);
  const names = ["sunken cathedral", "airship deck", "glacier rift", "x", "Crystal Spire of Frost Giants", "bone orchard", "a very very long name that gets cut", "marsh", "clockwork foundry", "💥 boom", "candy forest", "tavern"];
  const refId = () => r.pick([...MATERIAL_IDS, "nonsense_thing", "moon_dust", "glowing_mossy_stone", "x"]);
  const draft = (role: MaterialRole) => ({
    name: `Odd ${r.int(0, 99)}`, role, color: `#${r.int(0, 0xffffff).toString(16).padStart(6, "0")}`, pattern: r.pick(["wobbly", "bricks", "swirl", "zz", "polka dots"]),
    tags: r.chance(0.3) ? ["tree"] : [], prompt_traits: "",
    ...(role === "hazard" && r.chance(0.5) ? { hazard: { damage_type: r.pick(["fire", "cold", "acid"] as const), dice: "1d6" } } : {}),
    ...(r.chance(0.2) ? { walkable: r.chance(0.5) } : {}),
  });
  const materials: Record<string, unknown[]> = {};
  if (r.chance(0.5)) {
    for (const [role, max] of [["floor", 3], ["path", 3], ["wall", 3], ["obstacle", 3], ["liquid", 3], ["hazard", 3], ["decor", 6]] as const) {
      if (r.chance(0.5)) materials[role] = Array.from({ length: r.int(0, max) }, () => (r.chance(0.7) ? refId() : draft(role)));
    }
  }
  return {
    setting: {
      name: r.pick(names),
      ...(r.chance(0.5) ? { preset: r.pick(SETTING_PRESETS) } : {}),
      layout: r.pick(LAYOUTS), environment: r.pick(ENVIRONMENTS), mood: r.pick(MOODS),
      ...(Object.keys(materials).length ? { materials } : {}),
      ...(r.chance(0.4) ? { density: { obstacles: r.int(0, 3), liquid: r.int(0, 3), hazards: r.int(0, 3) } } : {}),
    },
    theme_tags: r.chance(0.5) ? [r.pick(["fog", "marsh", "frozen", "haunted", "clockwork"])] : [],
    size_class: r.pick(SIZE_CLASSES),
    rooms: ids.map((id) => ({
      id, type: r.pick(ROOM_TYPES), size: r.pick(SIZES),
      connects_to: ids.filter((o) => o !== id && r.chance(1.5 / n)),
    })),
    points_of_interest: Array.from({ length: r.int(0, 8) }, () => ({ kind: r.pick(["altar", "chest", "drowned pipe organ", "fountain", "lever", "door", "statue", "sign", "barrel", "???", "ancient whispering idol"]), room_id: r.pick(ids) })),
    entity_slots: Array.from({ length: r.int(0, 8) }, () => ({ role: r.pick(["enemy", "npc", "boss", "loot"] as const), room_id: r.pick(ids), count: r.int(1, 6) })),
    exits: Array.from({ length: r.int(1, 4) }, (_, i) => ({ side: r.pick(["north", "south", "east", "west"] as const), label: `Exit ${i}` })),
  } as MapBrief;
}

describe("fuzz", () => {
  it("never throws and always validates for 500 random briefs", () => {
    const r = new MapRng(2024);
    const stats = { fallback: 0 };
    let genMs = 0;
    for (let i = 0; i < 500; i++) {
      const b = randomBrief(r);
      const t0 = performance.now();
      const { map, attempts } = generateMap(b, { seed: i * 7 + 1, id: "m_fuzz" });
      genMs += performance.now() - t0;
      if (attempts > 3) stats.fallback++;
      (stats as Record<string, number>)[`a${attempts}`] = ((stats as Record<string, number>)[`a${attempts}`] ?? 0) + 1;
      checkMap(map, b, i % 10 === 0, attempts <= 3);
    }
    if (process.env.FUZZ_STATS) console.log("fuzz fallbacks", stats.fallback, genMs.toFixed(0) + "ms gen", JSON.stringify(stats));
    // the fallback chain should be rare
    expect(stats.fallback).toBeLessThan(75);
  });
});

// ---------- navigation and validation ----------

const tile = (gid: number, material_id: string, role: InlineTileset["tiles"][number]["role"], layerName: "ground" | "walls") => ({
  gid, material_id, role, color: "#7cb342", accent: "#4f8a3c", pattern: "none" as const,
  walkable: layerName !== "walls", blocks_sight: role === "wall", variant: 0, layer: layerName,
});
const TILESET: InlineTileset = {
  first_gid: 1,
  tiles: [tile(1, "meadow_grass", "floor", "ground"), tile(2, "stone_brick_wall", "wall", "walls"), tile(3, "wooden_door", "door", "ground"), tile(4, "fire_patch", "hazard", "ground")],
};
const FLOOR = 1;
const WALL = 2;
const DOOR = 3;
const HAZARD = 4;

/** Hand-built 20x20 map: open room walled at the border. */
function blank(): GameMap {
  const n = 400;
  const walls = new Array<number>(n).fill(0);
  for (let i = 0; i < 20; i++) {
    walls[i] = WALL; walls[19 * 20 + i] = WALL; walls[i * 20] = WALL; walls[i * 20 + 19] = WALL;
  }
  return {
    v: 2, id: "m_test", width: 20, height: 20, tile_size: 48,
    tileset: structuredClone(TILESET),
    layers: [
      { type: "tilelayer", name: "ground", data: new Array<number>(n).fill(FLOOR) },
      { type: "tilelayer", name: "walls", data: walls },
      { type: "tilelayer", name: "decor", data: new Array<number>(n).fill(0) },
      { type: "tilelayer", name: "above", data: new Array<number>(n).fill(0) },
      { type: "objectgroup", name: "objects", objects: [{ type: "spawn", name: "party_start", x: 2, y: 2 }] },
    ],
    meta: { setting: { name: "Test field", preset: "forest", layout: "open_field", environment: "outdoor", mood: "bright" }, theme_tags: [], seed: 1, generated_at: "1970-01-01T00:00:00Z" },
  };
}
const wallsOf = (m: GameMap) => (m.layers[1] as { data: number[] }).data;
const groundOf = (m: GameMap) => (m.layers[0] as { data: number[] }).data;
const objsOf = (m: GameMap) => getObjects(m);

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
    for (let y = 2; y <= 17; y++) wallsOf(m)[y * 20 + 10] = WALL;
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
    wallsOf(m)[5 * 20 + 6] = WALL;
    wallsOf(m)[6 * 20 + 5] = WALL;
    expect(findPath(m, { x: 5, y: 5 }, { x: 6, y: 6 })!.length).toBeGreaterThan(1);
    const m2 = blank();
    const occ = new Set(["6,5", "6,6", "6,7"]);
    const p = findPath(m2, { x: 5, y: 6 }, { x: 7, y: 6 }, occ)!;
    expect(p.some((q) => occ.has(`${q.x},${q.y}`))).toBe(false);
  });

  it("hasLineOfSight is blocked by walls and blockers but not by endpoints", () => {
    const m = blank();
    expect(hasLineOfSight(m, { x: 2, y: 5 }, { x: 8, y: 5 })).toBe(true);
    wallsOf(m)[5 * 20 + 5] = WALL;
    expect(hasLineOfSight(m, { x: 2, y: 5 }, { x: 8, y: 5 })).toBe(false);
    expect(hasLineOfSight(m, { x: 2, y: 5 }, { x: 5, y: 5 })).toBe(true);
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
  it("accepts a good map (unused tile definitions are only warnings)", () => {
    const v = validateMap(ok());
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
    expect(v.warnings.join()).toContain("not used");
  });

  it("rule 1: data length", () => {
    const m = ok();
    (m.layers[2] as { data: number[] }).data.pop();
    expect(validateMap(m).errors.join()).toContain("rule 1");
  });
  it("rule 2: tile id without a TileDef", () => {
    const m = ok();
    groundOf(m)[50] = 9999;
    expect(validateMap(m).errors.join()).toContain("rule 2");
  });
  it("rule 3: party_start in a wall", () => {
    const m = ok();
    wallsOf(m)[2 * 20 + 2] = WALL;
    expect(validateMap(m).errors.join()).toContain("rule 3");
  });
  it("rule 4: unreachable slot", () => {
    const m = ok();
    for (let y = 1; y < 19; y++) wallsOf(m)[y * 20 + 10] = WALL;
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
    groundOf(m)[8 * 20 + 8] = DOOR;
    expect(validateMap(m).ok).toBe(true);
  });
  it("rule 7: too big", () => {
    const m = ok();
    m.meta.theme_tags = ["x".repeat(300 * 1024)];
    expect(validateMap(m).errors.join()).toContain("rule 7");
  });
  it("rule 8: a hazard wall across the only way", () => {
    const m = ok();
    for (let y = 1; y < 19; y++) groundOf(m)[y * 20 + 10] = HAZARD;
    const v = validateMap(m);
    expect(v.errors.join()).toContain("rule 8");
    expect(v.errors.join()).not.toContain("rule 4");
    // leave a gap and the map is fine again
    groundOf(m)[5 * 20 + 10] = FLOOR;
    expect(validateMap(m).ok).toBe(true);
  });
  it("rule 8: party_start on a hazard", () => {
    const m = ok();
    groundOf(m)[2 * 20 + 2] = HAZARD;
    expect(validateMap(m).errors.join()).toContain("rule 8");
  });
});

describe("stripOrphanTiles", () => {
  it("drops unused definitions and renumbers the layers", () => {
    const m = blank();
    groundOf(m)[100] = HAZARD; // gid 4 used, gid 3 not
    const s = stripOrphanTiles(m);
    expect(s.tileset.tiles.map((t) => t.material_id)).toEqual(["meadow_grass", "stone_brick_wall", "fire_patch"]);
    expect(s.tileset.tiles.map((t) => t.gid)).toEqual([1, 2, 3]);
    expect(groundOf(s)[100]).toBe(3);
    expect(validateMap(s).warnings).toEqual([]);
    expect(stripOrphanTiles(s)).toBe(s);
  });
});

describe("renderAscii", () => {
  const snap = (b: MapBrief, seed: number) => {
    const { map } = generateMap({ ...b, size_class: "small" }, { seed, id: "m_snap" });
    const art = renderAscii(map);
    expect(art.split("\n")).toHaveLength(map.height);
    return art;
  };
  it("renders a small cave (snapshot)", () => {
    const art = snap(STARTER_BRIEFS.cave, 11);
    expect(art).toMatchSnapshot();
    for (const c of ["S", "E", "e", "c", "#"]) expect(art).toContain(c);
  });
  it("renders a small settlement (snapshot)", () => {
    const art = snap(STARTER_BRIEFS.town, 11);
    expect(art).toMatchSnapshot();
    for (const c of ["S", "E", "e", "c", "#", "+", ":"]) expect(art).toContain(c);
  });
  it("renders a small island map (snapshot)", () => {
    const art = snap(STARTER_BRIEFS.beach, 11);
    expect(art).toMatchSnapshot();
    for (const c of ["S", "E", "e", "~", ":"]) expect(art).toContain(c);
  });
  it("uses a letter per role", () => {
    const m = blank();
    wallsOf(m)[5 * 20 + 5] = WALL;
    groundOf(m)[6 * 20 + 6] = HAZARD;
    groundOf(m)[7 * 20 + 7] = DOOR;
    const rows = renderAscii(m).split("\n");
    expect(rows[5]![5]).toBe("#");
    expect(rows[6]![6]).toBe("^");
    expect(rows[7]![7]).toBe("+");
    expect(rows[2]![2]).toBe("S");
    expect(rows[9]![9]).toBe(".");
  });
});

void MATERIAL_ROLES;
