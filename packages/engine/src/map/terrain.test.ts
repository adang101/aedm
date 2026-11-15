/** Properties of the natural-terrain generators: coherent ground, water, paths, vegetation, clearings, border, speed. */
import { describe, expect, it } from "vitest";
import { ENVIRONMENTS, LAYOUTS, SETTING_PRESETS } from "@aedm/schemas";
import type { GameMap, Layout, MapBrief, SettingPreset } from "@aedm/schemas";
import { LAYOUT_PLANS, STARTER_BRIEFS, generateMap, getObjects, getSpawn, validateMap } from "./index";

const SEEDS = [3, 58, 1234, 40404, 777001];
const OUTDOOR_PRESETS: SettingPreset[] = ["forest", "swamp", "snowfield", "desert", "ruins", "mountain_pass", "beach", "farmland", "town"];

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

function layerOf(map: GameMap, name: string): number[] {
  const l = map.layers.find((x) => x.type === "tilelayer" && x.name === name);
  return l && l.type === "tilelayer" ? l.data : [];
}

function view(map: GameMap) {
  const defs = new Map(map.tileset.tiles.map((t) => [t.gid, t]));
  const { width: w, height: h } = map;
  const ground = layerOf(map, "ground").map((g) => defs.get(g));
  const walls = layerOf(map, "walls").map((g) => defs.get(g));
  const open = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && !walls[y * w + x];
  return { w, h, ground, walls, open };
}

/** A starter brief for a preset, optionally forced onto a layout (with that layout's own room plan). */
function briefOf(preset: SettingPreset, over: { layout?: Layout; size?: MapBrief["size_class"]; density?: MapBrief["setting"]["density"] } = {}): MapBrief {
  const b = STARTER_BRIEFS[preset];
  const size_class = over.size ?? "medium";
  if (!over.layout && !over.density) return { ...b, size_class };
  const layout = over.layout ?? b.setting.layout;
  const plan = LAYOUT_PLANS[layout];
  const setting = { ...b.setting, layout, ...(over.density ? { density: over.density } : {}) };
  if (layout === b.setting.layout) return { ...b, setting, size_class };
  return {
    ...b,
    setting,
    size_class,
    rooms: plan.rooms.map(([id, type, size, connects_to]) => ({ id, type, size, connects_to })),
    points_of_interest: b.points_of_interest.map((p, i) => ({ ...p, room_id: plan.poi[i % plan.poi.length]! })),
    entity_slots: b.entity_slots.map((s) => ({ ...s, room_id: plan.enemies })),
  };
}

describe("natural terrain", () => {
  it("is a pure function of brief and seed, and the seed matters", () => {
    for (const p of ["forest", "swamp", "beach", "town", "cave", "mountain_pass"] as const) {
      const a = generateMap(STARTER_BRIEFS[p], { seed: 91, id: "m" }).map;
      expect(generateMap(STARTER_BRIEFS[p], { seed: 91, id: "m" }).map).toEqual(a);
      expect(generateMap(STARTER_BRIEFS[p], { seed: 92, id: "m" }).map).not.toEqual(a);
    }
  });

  it("never leaves a single-tile patch of a secondary ground material", () => {
    for (const p of SETTING_PRESETS) {
      for (const seed of SEEDS) {
        const { map } = generateMap(briefOf(p), { seed, id: "m" });
        const { w, h, ground } = view(map);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const g = ground[y * w + x];
            if (g?.role !== "floor") continue;
            let same = 0;
            let floors = 0;
            for (const [dx, dy] of DIRS) {
              const n = x + dx >= 0 && y + dy >= 0 && x + dx < w && y + dy < h ? ground[(y + dy) * w + x + dx] : undefined;
              if (n?.role === "floor") floors++;
              if (n?.role === "floor" && n.material_id === g.material_id) same++;
            }
            if (floors > 0) expect(same, `${p}/${seed}: lone ${g.material_id} tile at ${x},${y}`).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it("makes water in contiguous bodies, and never lets it cut off an exit or point of interest", () => {
    for (const p of ["forest", "swamp", "snowfield", "farmland", "beach", "ruins"] as const) {
      for (const seed of SEEDS) {
        const b = briefOf(p, { density: { obstacles: 2, liquid: 3, hazards: 0 } });
        const { map } = generateMap(b, { seed, id: "m" });
        expect(validateMap(map).errors).toEqual([]);
        const { w, h, walls } = view(map);
        const seen = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) {
          if (seen[i] || walls[i]?.role !== "liquid") continue;
          let size = 0;
          const stack = [i];
          seen[i] = 1;
          while (stack.length) {
            const c = stack.pop()!;
            size++;
            const x = c % w;
            const y = (c - x) / w;
            for (const [dx, dy] of DIRS) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              const n = ny * w + nx;
              if (!seen[n] && walls[n]?.role === "liquid") { seen[n] = 1; stack.push(n); }
            }
          }
          expect(size, `${p}/${seed}: water body of ${size} tile(s) at ${i % w},${Math.floor(i / w)}`).toBeGreaterThanOrEqual(4);
        }
      }
    }
  });

  it("crosses water with a walkable crossing wherever a route needs one", () => {
    let crossings = 0;
    let wet = 0;
    for (const seed of Array.from({ length: 24 }, (_, i) => 100 + i * 31)) {
      const b = briefOf("swamp", { density: { obstacles: 2, liquid: 3, hazards: 0 } });
      const { map } = generateMap(b, { seed, id: "m" });
      const { w, h, ground, walls } = view(map);
      if (walls.some((t) => t?.role === "liquid")) wet++;
      for (let i = 0; i < w * h; i++) {
        const g = ground[i];
        if (g?.role === "path" && g.material_id.includes("plank")) crossings++;
        if (g?.role === "liquid" && !walls[i]) crossings++;
      }
      void h;
    }
    expect(wet).toBeGreaterThan(18);
    expect(crossings).toBeGreaterThan(wet / 2);
  });

  it("joins every point of interest, entity slot and exit to the path network in the trail and open layouts", () => {
    for (const p of ["forest", "swamp", "snowfield", "desert", "mountain_pass", "ruins"] as const) {
      for (const seed of SEEDS) {
        const { map } = generateMap(briefOf(p), { seed, id: "m" });
        const { w, h, ground, open } = view(map);
        const isPath = (x: number, y: number): boolean => {
          const g = ground[y * w + x];
          return open(x, y) && (g?.role === "path" || g?.role === "door" || (g?.role === "liquid" && g.walkable));
        };
        const exits = getObjects(map).filter((o) => o.type === "exit");
        const seen = new Uint8Array(w * h);
        const stack: number[] = [];
        for (const e of exits) if (isPath(e.x, e.y)) { seen[e.y * w + e.x] = 1; stack.push(e.y * w + e.x); }
        expect(stack.length, `${p}/${seed}: exits stand on path tiles`).toBe(exits.length);
        while (stack.length) {
          const c = stack.pop()!;
          const x = c % w;
          const y = (c - x) / w;
          for (const [dx, dy] of DIRS) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h || seen[ny * w + nx] || !isPath(nx, ny)) continue;
            seen[ny * w + nx] = 1;
            stack.push(ny * w + nx);
          }
        }
        for (const o of getObjects(map)) {
          // traps are scattered by the trap placer, not part of the composition
          if (o.type === "interactable" ? o.kind === "trap" : o.type !== "entity_slot" && o.type !== "spawn") continue;
          let near = false;
          for (let dy = -5; dy <= 5 && !near; dy++) for (let dx = -5; dx <= 5 && !near; dx++) {
            const x = o.x + dx;
            const y = o.y + dy;
            if (x >= 0 && y >= 0 && x < w && y < h && seen[y * w + x]) near = true;
          }
          expect(near, `${p}/${seed}: ${o.type} at ${o.x},${o.y} is within 5 tiles of the path network`).toBe(true);
        }
      }
    }
  });

  it("keeps open ground around the party start and the enemy slots", () => {
    for (const p of ["forest", "swamp", "snowfield", "desert", "ruins", "mountain_pass"] as const) {
      for (const seed of SEEDS) {
        const { map } = generateMap(briefOf(p), { seed, id: "m" });
        const { open } = view(map);
        const openIn = (cx: number, cy: number, r: number): number => {
          let n = 0;
          for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) if (open(x, y)) n++;
          return n;
        };
        const s = getSpawn(map, "party_start")!;
        expect(openIn(s.x, s.y, 2), `${p}/${seed}: start 5x5`).toBeGreaterThanOrEqual(18);
        for (const o of getObjects(map)) {
          if (o.type === "entity_slot" && (o.role === "enemy" || o.role === "boss")) {
            expect(openIn(o.x, o.y, 2), `${p}/${seed}: ${o.id} 5x5`).toBeGreaterThanOrEqual(10);
          }
        }
      }
    }
  });

  it("builds the outdoor boundary as a treeline, not a picket row of alternating props", () => {
    for (const p of ["forest", "swamp", "mountain_pass", "ruins"] as const) {
      let changes = 0;
      let pairs = 0;
      for (const seed of SEEDS) {
        const { map } = generateMap(briefOf(p), { seed, id: "m" });
        const { w, h, walls } = view(map);
        const ring: Array<string | undefined> = [];
        for (let x = 0; x < w; x++) ring.push(walls[x]?.material_id);
        for (let y = 1; y < h; y++) ring.push(walls[y * w + w - 1]?.material_id);
        for (let x = w - 2; x >= 0; x--) ring.push(walls[(h - 1) * w + x]?.material_id);
        for (let y = h - 2; y > 0; y--) ring.push(walls[y * w]?.material_id);
        for (let i = 1; i < ring.length; i++) {
          if (!ring[i] || !ring[i - 1]) continue;
          pairs++;
          if (ring[i] !== ring[i - 1]) changes++;
        }
      }
      expect(changes / pairs, `${p}: share of neighbouring border tiles that differ`).toBeLessThan(0.4);
    }
  });

  it("clusters vegetation instead of sprinkling it", () => {
    // in a sprinkled field most obstacles stand alone; in groves most have an obstacle neighbour
    for (const seed of SEEDS) {
      const { map } = generateMap(briefOf("forest", { density: { obstacles: 2, liquid: 0, hazards: 0 } }), { seed, id: "m" });
      const { w, h, walls } = view(map);
      let total = 0;
      let touching = 0;
      for (let y = 4; y < h - 4; y++) {
        for (let x = 4; x < w - 4; x++) {
          if (walls[y * w + x]?.role !== "obstacle") continue;
          total++;
          if (DIRS.some(([dx, dy]) => walls[(y + dy) * w + x + dx]?.role === "obstacle")) touching++;
        }
      }
      expect(total).toBeGreaterThan(20);
      expect(touching / total, `seed ${seed}`).toBeGreaterThan(0.6);
    }
  });

  it("generates fast, for every layout, environment and preset", () => {
    const t0 = performance.now();
    let n = 0;
    let worst = 0;
    const time = (b: MapBrief, seed: number): void => {
      const t = performance.now();
      generateMap(b, { seed, id: "m" });
      worst = Math.max(worst, performance.now() - t);
      n++;
    };
    for (const p of SETTING_PRESETS) for (const size of ["small", "large"] as const) for (const seed of SEEDS.slice(0, 3)) time(briefOf(p, { size }), seed);
    for (const layout of LAYOUTS) {
      for (const environment of ENVIRONMENTS) {
        const b = briefOf("forest", { layout, size: "large" });
        for (const seed of SEEDS.slice(0, 2)) time({ ...b, setting: { ...b.setting, environment } }, seed);
      }
    }
    expect((performance.now() - t0) / n, "mean ms per map").toBeLessThan(40);
    expect(worst, "slowest map in ms").toBeLessThan(500);
  });

  it("keeps working when the outdoor presets are forced onto every layout", () => {
    for (const p of OUTDOOR_PRESETS) {
      for (const layout of LAYOUTS) {
        const b = briefOf(p, { layout });
        for (const seed of SEEDS.slice(0, 3)) {
          const { map, attempts } = generateMap(b, { seed, id: "m" });
          expect(validateMap(map).errors).toEqual([]);
          expect(attempts, `${p}/${layout}/${seed}`).toBeLessThanOrEqual(3);
        }
      }
    }
  });
});
