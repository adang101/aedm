/** Regressions for the second terrain pass: settlements, interiors, plain settings and rivers. */
import { describe, expect, it } from "vitest";
import { SETTING_PRESETS } from "@aedm/schemas";
import type { GameMap, SettingPreset } from "@aedm/schemas";
import { STARTER_BRIEFS, generateMap, resolveSetting } from "./index";
import { lum } from "./contrast";
import { rampPosition } from "./materials";
import { Grid } from "./layouts/grid";
import { carveRiver, computeFields, roomDistance } from "./nature";
import { MapRng } from "./prng";

const SEEDS = [3, 58, 1234, 40404, 777001, 91, 5150];

function layer(map: GameMap, name: string): number[] {
  const l = map.layers.find((x) => x.type === "tilelayer" && x.name === name);
  return l && l.type === "tilelayer" ? l.data : [];
}

describe("settlements", () => {
  it("never pairs a path material with a strongly coloured one from another ramp (no red brick across grey cobble)", () => {
    for (const p of SETTING_PRESETS) {
      const s = resolveSetting({ name: p, preset: p, layout: STARTER_BRIEFS[p].setting.layout, environment: STARTER_BRIEFS[p].setting.environment, mood: "neutral" });
      const [first, ...rest] = s.materials.path;
      const a = rampPosition(first!.color)?.ramp;
      for (const m of rest) {
        const b = rampPosition(m.color)?.ramp;
        const neutral = (r?: string) => r === "stone" || r === "earth" || r === "sand";
        if (!a || !b || a === b || (neutral(a) && neutral(b)) || first!.id.includes("carpet") || m.id.includes("carpet")) continue;
        throw new Error(`${p}: path ${m.id} (${b}) beside ${first!.id} (${a})`);
      }
    }
  });

  it("draws each building as one roof: one wall material and tone per connected block", () => {
    for (const p of ["town", "market"] as const) {
      for (const seed of SEEDS) {
        const { map } = generateMap({ ...STARTER_BRIEFS[p], size_class: "large" }, { seed, id: "m" });
        const defs = new Map(map.tileset.tiles.map((t) => [t.gid, t]));
        const walls = layer(map, "walls");
        const { width: w, height: h } = map;
        const isRoof = (i: number) => defs.get(walls[i] ?? 0)?.role === "wall";
        const seen = new Uint8Array(w * h);
        let blocks = 0;
        let mixed = 0;
        for (let s = 0; s < w * h; s++) {
          if (seen[s] || !isRoof(s)) continue;
          const gids = new Set<number>();
          const stack = [s];
          seen[s] = 1;
          while (stack.length) {
            const c = stack.pop()!;
            gids.add(walls[c]!);
            const x = c % w;
            const y = (c - x) / w;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              const n = ny * w + nx;
              if (!seen[n] && isRoof(n)) { seen[n] = 1; stack.push(n); }
            }
          }
          blocks++;
          if (gids.size > 1) mixed++;
        }
        expect(blocks).toBeGreaterThan(0);
        // buildings that touch (the generator allows that only as a last resort) may share a block
        expect(mixed, `${p}/${seed}: ${mixed} of ${blocks} blocks mix roof tiles`).toBeLessThanOrEqual(Math.max(1, Math.floor(blocks / 6)));
      }
    }
  });

  it("makes ponds round: a lake is never a thin stair of one-tile steps", () => {
    for (const seed of SEEDS) {
      const { map } = generateMap({ ...STARTER_BRIEFS.town, setting: { ...STARTER_BRIEFS.town.setting, density: { obstacles: 1, liquid: 3, hazards: 0 } }, size_class: "large" }, { seed, id: "m" });
      const defs = new Map(map.tileset.tiles.map((t) => [t.gid, t]));
      const walls = layer(map, "walls");
      const { width: w, height: h } = map;
      const wet = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && defs.get(walls[y * w + x] ?? 0)?.role === "liquid";
      // a concave notch: a dry tile with water on three sides is a stair artefact
      let notches = 0;
      let water = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          if (wet(x, y)) { water++; continue; }
          const around = [wet(x + 1, y), wet(x - 1, y), wet(x, y + 1), wet(x, y - 1)].filter(Boolean).length;
          if (around >= 3) notches++;
        }
      }
      expect(notches, `${seed}: ${notches} notches in ${water} water tiles`).toBeLessThanOrEqual(4);
    }
  });
});

describe("interiors", () => {
  it("leaves the solid mass between rooms as one material (no isolated blocks of another wall)", () => {
    for (const p of ["interior", "dungeon", "castle", "crypt", "temple"] as const) {
      for (const seed of SEEDS) {
        const { map } = generateMap(STARTER_BRIEFS[p], { seed, id: "m" });
        const defs = new Map(map.tileset.tiles.map((t) => [t.gid, t]));
        const walls = layer(map, "walls");
        const { width: w, height: h } = map;
        const open = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && (walls[y * w + x] ?? 0) === 0;
        const deep = new Set<string>();
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const d = defs.get(walls[y * w + x] ?? 0);
            if (!d || d.role !== "wall") continue;
            let near = false;
            for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2 && !near; dx++) if (open(x + dx, y + dy)) near = true;
            if (!near) deep.add(d.material_id);
          }
        }
        expect(deep.size, `${p}/${seed}: ${[...deep].join(",")}`).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("plain settings", () => {
  it("keeps the primary path distinct from the ground it crosses (a swamp track is not mud on mud)", () => {
    for (const p of SETTING_PRESETS) {
      const s = resolveSetting({ name: p, preset: p, layout: STARTER_BRIEFS[p].setting.layout, environment: STARTER_BRIEFS[p].setting.environment, mood: STARTER_BRIEFS[p].setting.mood });
      const path = s.materials.path[0]!;
      for (const f of s.materials.floor.slice(0, 1)) {
        const distinct = Math.abs(lum(path.color) - lum(f.color)) >= 0.1 || path.pattern !== f.pattern;
        expect(distinct, `${p}: ${path.id} on ${f.id}`).toBe(true);
      }
    }
  });

  it("scatters props thickly enough that swamp, desert and snowfield are not bare", () => {
    for (const p of ["swamp", "desert", "snowfield"] as SettingPreset[]) {
      let total = 0;
      let open = 0;
      for (const seed of SEEDS) {
        const { map } = generateMap(STARTER_BRIEFS[p], { seed, id: "m" });
        const decor = layer(map, "decor");
        const walls = layer(map, "walls");
        decor.forEach((g, i) => { if (walls[i] === 0) { open++; if (g !== 0) total++; } });
      }
      expect(total / open, p).toBeGreaterThan(0.045);
    }
  });
});

describe("rivers", () => {
  it("are a few tiles wide with smooth banks, not thick bands", () => {
    let made = 0;
    for (const seed of SEEDS.concat([11, 12, 13, 14, 15, 16])) {
      const grid = new Grid(40, 32);
      computeFields(grid, seed);
      const rng = new MapRng(seed);
      const rd = roomDistance(grid);
      if (!carveRiver(grid, rng, 3, () => true, rd)) continue;
      made++;
      const wet = (x: number, y: number) => grid.get(x, y) === 4;
      let cells = 0;
      let thick = 0;
      for (let y = 1; y < grid.h - 1; y++) {
        for (let x = 1; x < grid.w - 1; x++) {
          if (!wet(x, y)) continue;
          cells++;
          // the water tile is more than 3 tiles from the dry land in a straight line, i.e. a band of 7 or more
          let run = 1;
          for (let k = 1; wet(x + k, y); k++) run++;
          for (let k = 1; wet(x - k, y); k++) run++;
          let runV = 1;
          for (let k = 1; wet(x, y + k); k++) runV++;
          for (let k = 1; wet(x, y - k); k++) runV++;
          if (Math.min(run, runV) > 5) thick++;
        }
      }
      expect(cells / Math.max(grid.w, grid.h), `seed ${seed}: ${cells} river tiles`).toBeLessThan(3.6);
      expect(thick, `seed ${seed}`).toBeLessThanOrEqual(Math.ceil(cells * 0.06));
    }
    expect(made).toBeGreaterThan(3);
  });
});
