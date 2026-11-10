/** One generation attempt: layout, exits, doors, start, reachability, objects, hazards, decor, tile assembly. */
import { PALETTE } from "@aedm/schemas";
import type { GameMap, InteractableKind, MapBrief, MapObject, Material } from "@aedm/schemas";
import { assemble } from "./assemble";
import { LAYOUT_GENERATORS, borderTerrain, pocketTerrain } from "./layouts/index";
import { DIRS4, Grid, T, isPassable, level } from "./layouts/grid";
import type { Pt, RoomShape } from "./layouts/grid";
import { closestPattern, findMaterial, getMaterial, resolveMaterial, words } from "./materials";
import { MapRng } from "./prng";
import { resolveSetting } from "./settings";
import type { ResolvedSetting } from "./settings";

export interface BuildOptions {
  id: string;
  generatedAt: string;
}

const SIZE_RANGE = { small: [20, 30], medium: [30, 45], large: [45, 60] } as const;

// ---------- exits ----------

function placeExits(grid: Grid, shapes: readonly RoomShape[], brief: MapBrief, exitPoints: ReadonlyArray<Pt | undefined> | undefined, reach: Uint8Array): MapObject[] {
  const out: MapObject[] = [];
  const used: Pt[] = [];
  const real = shapes.filter((s) => !s.extra);
  brief.exits.forEach((ex, i) => {
    const name = ex.label.trim().slice(0, 32).trim() || ex.side;
    const given = exitPoints?.[i];
    if (given) {
      used.push(given);
      out.push({ type: "exit", name, to: "pending", target_entry: "party_start", x: given.x, y: given.y });
      return;
    }
    const key = (t: Pt) => (ex.side === "north" ? t.y : ex.side === "south" ? -t.y : ex.side === "west" ? t.x : -t.x);
    // the room nearest the side first, then the others; exits keep 2 tiles apart where they can, 1 where they must
    const ranked = real
      .map((r) => ({ r, s: Math.min(...r.tiles.map(key)) }))
      .sort((p, q) => p.s - q.s)
      .map((e) => e.r);
    for (const gap of [2, 1]) {
      for (const room of ranked) {
        const along = (t: Pt) => (ex.side === "north" || ex.side === "south" ? Math.abs(t.x - room.center.x) : Math.abs(t.y - room.center.y));
        const cands = room.tiles.filter((t) => reach[grid.idx(t.x, t.y)]).sort((a, b) => key(a) - key(b) || along(a) - along(b) || a.y - b.y || a.x - b.x);
        for (const t of cands) {
          const end: Pt =
            ex.side === "north" ? { x: t.x, y: 0 } : ex.side === "south" ? { x: t.x, y: grid.h - 1 } : ex.side === "west" ? { x: 0, y: t.y } : { x: grid.w - 1, y: t.y };
          if ((end.x === 0 || end.x === grid.w - 1) && (end.y < 2 || end.y > grid.h - 3)) continue;
          if ((end.y === 0 || end.y === grid.h - 1) && (end.x < 2 || end.x > grid.w - 3)) continue;
          if (used.some((q) => Math.max(Math.abs(q.x - end.x), Math.abs(q.y - end.y)) < gap)) continue;
          const inn = { x: Math.min(grid.w - 2, Math.max(1, end.x)), y: Math.min(grid.h - 2, Math.max(1, end.y)) };
          grid.route(t, inn, ex.side === "west" || ex.side === "east", 1, false);
          grid.carve(end.x, end.y, false, true);
          grid.t[grid.idx(end.x, end.y)] = T.PATH;
          used.push(end);
          out.push({ type: "exit", name, to: "pending", target_entry: "party_start", x: end.x, y: end.y });
          return;
        }
      }
    }
    throw new Error(`could not place ${ex.side} exit`);
  });
  return out;
}

/** Door tiles where a 1-wide opening meets a room. */
function addDoors(grid: Grid): void {
  for (let i = 0; i < grid.t.length; i++) {
    if (grid.t[i] !== T.PATH || grid.room[i]! >= 0) continue;
    const x = i % grid.w;
    const y = (i - x) / grid.w;
    if (grid.border(x, y)) continue;
    for (const [dx, dy] of DIRS4) {
      const nx = x + dx;
      const ny = y + dy;
      if (!grid.inside(nx, ny) || grid.room[grid.idx(nx, ny)]! < 0) continue;
      const sideWalled = !grid.passable(x + dy, y + dx) && !grid.passable(x - dy, y - dx);
      const behind = grid.passable(x - dx, y - dy);
      if (sideWalled && behind) {
        grid.t[i] = T.DOOR;
        break;
      }
    }
  }
}

// ---------- objects ----------

const INTERACTABLES = ["chest", "door", "lever", "sign", "altar"] as const;

export function interactableKind(kind: string): InteractableKind | null {
  const k = kind.toLowerCase();
  for (const name of INTERACTABLES) if (k.includes(name)) return name;
  return null;
}

const INTERACTABLE_PROP: Record<Exclude<InteractableKind, "door">, string> = {
  chest: "treasure_chest", lever: "wall_lever", sign: "signpost", altar: "stone_altar",
};

const MOOD_RAMPS = {
  eerie: ["magic"], dark: ["stone", "earth"], dim: ["stone", "earth"], bright: ["sand", "grass", "water"], neutral: ["stone", "earth", "sand"],
} as const;

const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** A decor material for a free-text point of interest: from the library when the name fits, else a custom prop. */
export function propFor(kind: string, setting: ResolvedSetting): Material {
  const ctx = { tags: words(setting.name), mood: setting.mood };
  const hit = findMaterial(kind, "decor", ctx, true);
  if (hit) return hit;
  // a prop that the library only knows as an obstacle (barrel, crate, statue) is drawn as a walkable decor piece
  const solid = findMaterial(kind, "obstacle", ctx, true);
  if (solid) return { ...solid, role: "decor", walkable: true, blocks_sight: false };
  const ramps = MOOD_RAMPS[setting.mood];
  let h = 0;
  for (const ch of kind) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const ramp = ramps[h % ramps.length]!;
  return resolveMaterial(
    {
      name: titleCase(kind.trim()).slice(0, 40),
      role: "decor",
      color: PALETTE[ramp][2 + (h % 2)]!,
      pattern: closestPattern(kind),
      tags: ["custom", ...words(kind).slice(0, 2)],
      prompt_traits: `a ${kind.trim()} fitting a ${setting.name}`.slice(0, 120),
    } as never,
    "decor",
    ctx,
  );
}

function bfsPath(grid: Grid, from: number, to: number): number[] {
  const prev = new Map<number, number>([[from, -1]]);
  const queue = [from];
  for (let q = 0; q < queue.length; q++) {
    const c = queue[q]!;
    if (c === to) break;
    const x = c % grid.w;
    const y = (c - x) / grid.w;
    for (const [dx, dy] of DIRS4) {
      const nx = x + dx;
      const ny = y + dy;
      if (!grid.inside(nx, ny)) continue;
      const n = grid.idx(nx, ny);
      if (prev.has(n) || !isPassable(grid.t[n]!)) continue;
      prev.set(n, c);
      queue.push(n);
    }
  }
  const path: number[] = [];
  for (let c = prev.has(to) ? to : -1; c !== -1; c = prev.get(c)!) path.push(c);
  return path;
}

export function buildMap(brief: MapBrief, seed: number, opts: BuildOptions): GameMap {
  const rng = new MapRng(seed);
  const setting = resolveSetting(brief.setting, brief.theme_tags);
  const [lo, hi] = SIZE_RANGE[brief.size_class];
  const grid = new Grid(rng.int(lo, hi), rng.int(lo, hi));
  const { w } = grid;
  const hasShallow = setting.materials.liquid.some((m) => m.walkable);

  const layout = LAYOUT_GENERATORS[setting.layout];
  const out = layout({ grid, setting, rooms: brief.rooms, exits: brief.exits, rng, hasShallow });
  const shapes = out.shapes;
  grid.sealBorder(borderTerrain(setting.layout, setting.environment));

  // start: the open tile nearest the first room's center
  const first = shapes[0]!;
  let start: Pt | undefined;
  {
    const ok = (p: Pt) => grid.t[grid.idx(p.x, p.y)] === T.FLOOR || grid.t[grid.idx(p.x, p.y)] === T.PATH;
    const cands = first.tiles.filter(ok);
    cands.sort((a, b) => (a.x - first.center.x) ** 2 + (a.y - first.center.y) ** 2 - ((b.x - first.center.x) ** 2 + (b.y - first.center.y) ** 2) || a.y - b.y || a.x - b.x);
    start = cands[0];
    if (!start) {
      for (let y = 1; y < grid.h - 1 && !start; y++) for (let x = 1; x < w - 1 && !start; x++) if (ok({ x, y })) start = { x, y };
    }
  }
  if (!start) throw new Error("no open tile for the party start");

  // exits leave from tiles the party can already reach
  const exits = placeExits(grid, shapes, brief, out.exitPoints, grid.reachable(start));
  if (out.doors) addDoors(grid);

  // cut off pockets the party could never reach, then make sure every exit is still connected
  const seen = grid.reachable(start);
  const pocket = pocketTerrain(setting.layout, setting.environment);
  for (let i = 0; i < grid.t.length; i++) if (isPassable(grid.t[i]!) && !seen[i]) { grid.t[i] = pocket; grid.room[i] = -1; }
  for (const e of exits) if (e.type === "exit" && !seen[grid.idx(e.x, e.y)]) throw new Error(`exit ${e.name} is cut off`);

  const startIdx = grid.idx(start.x, start.y);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (grid.inside(start.x + dx, start.y + dy)) grid.crit[grid.idx(start.x + dx, start.y + dy)] = 1;
  const taken = new Set<number>([startIdx]);
  const objects: MapObject[] = [{ type: "spawn", name: "party_start", x: start.x, y: start.y }];
  for (const e of exits) {
    objects.push(e);
    taken.add(grid.idx(e.x, e.y));
    if (e.type === "exit") for (const [dx, dy] of DIRS4) if (grid.inside(e.x + dx, e.y + dy)) grid.crit[grid.idx(e.x + dx, e.y + dy)] = 1;
  }

  const byId = new Map(shapes.filter((s) => !s.extra).map((s) => [s.id, s]));
  const freeTile = (shape: RoomShape | undefined): Pt => {
    const ok = (p: Pt): boolean => {
      const i = grid.idx(p.x, p.y);
      return (grid.t[i] === T.FLOOR || grid.t[i] === T.PATH) && !taken.has(i) && !grid.border(p.x, p.y);
    };
    let cands = (shape ? shape.tiles : shapes.flatMap((s) => (s.extra ? [] : s.tiles))).filter(ok);
    if (cands.length === 0) {
      for (let y = 1; y < grid.h - 1; y++) for (let x = 1; x < w - 1; x++) if (ok({ x, y })) cands.push({ x, y });
    }
    if (cands.length === 0) throw new Error("no free tile for object");
    const loose = cands.filter((p) => !grid.crit[grid.idx(p.x, p.y)]);
    if (loose.length > 0) cands = loose;
    return rng.pick(cands);
  };

  const decor = new Map<number, Material>();
  brief.entity_slots.forEach((s, k) => {
    const p = freeTile(byId.get(s.room_id));
    taken.add(grid.idx(p.x, p.y));
    objects.push({ type: "entity_slot", id: `slot_${k + 1}`, role: s.role, count: s.count, x: p.x, y: p.y });
  });
  const counters = new Map<string, number>();
  for (const poi of brief.points_of_interest) {
    const p = freeTile(byId.get(poi.room_id));
    const i = grid.idx(p.x, p.y);
    taken.add(i);
    const ik = interactableKind(poi.kind);
    if (ik) {
      const n = (counters.get(ik) ?? 0) + 1;
      counters.set(ik, n);
      const state = ik === "chest" || ik === "door" ? (rng.chance(0.3) ? "locked" : "closed") : "closed";
      decor.set(i, ik === "door" ? setting.materials.door[0]! : (getMaterial(INTERACTABLE_PROP[ik]) ?? propFor(ik, setting)));
      objects.push({ type: "interactable", id: `${ik}_${n}`, kind: ik, state, x: p.x, y: p.y });
    } else {
      decor.set(i, propFor(poi.kind, setting));
    }
  }

  placeHazards(grid, setting, rng, taken, start);
  repairHazards(grid, objects, startIdx);
  scatterDecor(grid, setting, rng, taken, decor);

  const a = assemble({ grid, setting, seed, decor });
  return {
    v: 2,
    id: opts.id,
    width: grid.w,
    height: grid.h,
    tile_size: 48,
    tileset: a.tileset,
    layers: [
      { type: "tilelayer", name: "ground", data: a.ground },
      { type: "tilelayer", name: "walls", data: a.walls },
      { type: "tilelayer", name: "decor", data: a.decor },
      { type: "tilelayer", name: "above", data: a.above },
      { type: "objectgroup", name: "objects", objects },
    ],
    meta: {
      setting: {
        name: brief.setting.name,
        ...(brief.setting.preset ? { preset: brief.setting.preset } : {}),
        layout: setting.layout,
        environment: setting.environment,
        mood: setting.mood,
      },
      theme_tags: [...brief.theme_tags],
      seed,
      generated_at: opts.generatedAt,
    },
  };
}

// ---------- hazards and decor ----------

function placeHazards(grid: Grid, setting: ResolvedSetting, rng: MapRng, taken: ReadonlySet<number>, start: Pt): void {
  const d = level(setting.density.hazards);
  if (d === 0) return;
  const eligible = (i: number): boolean => {
    const x = i % grid.w;
    const y = (i - x) / grid.w;
    return grid.t[i] === T.FLOOR && !grid.crit[i] && !taken.has(i) && !grid.border(x, y) && Math.max(Math.abs(x - start.x), Math.abs(y - start.y)) >= 3;
  };
  const pool: number[] = [];
  for (let i = 0; i < grid.t.length; i++) if (eligible(i)) pool.push(i);
  if (pool.length < 12) return;
  const clusters = Math.min(40, Math.max(1, Math.round((d * pool.length) / 120)));
  for (let k = 0; k < clusters; k++) {
    const seed = pool[rng.int(0, pool.length - 1)]!;
    if (!eligible(seed)) continue;
    const mat = rng.int(0, setting.materials.hazard.length - 1);
    const cells = [seed];
    const size = rng.int(1, 3) + (d >= 2 ? 1 : 0);
    grid.t[seed] = T.HAZARD;
    grid.haz[seed] = mat;
    for (let s = 1; s < size; s++) {
      const base = cells[rng.int(0, cells.length - 1)]!;
      const [dx, dy] = DIRS4[rng.int(0, 3)]!;
      const nx = (base % grid.w) + dx;
      const ny = Math.floor(base / grid.w) + dy;
      if (!grid.inside(nx, ny)) continue;
      const n = grid.idx(nx, ny);
      if (!eligible(n)) continue;
      grid.t[n] = T.HAZARD;
      grid.haz[n] = mat;
      cells.push(n);
    }
  }
}

/** Hazards must never be the only way anywhere: where a target is cut off without crossing one, clear the shortest route. */
function repairHazards(grid: Grid, objects: readonly MapObject[], startIdx: number): void {
  const targets = objects.filter((o) => o.type === "exit" || o.type === "entity_slot" || o.type === "interactable").map((o) => grid.idx(o.x, o.y));
  const start = { x: startIdx % grid.w, y: Math.floor(startIdx / grid.w) };
  for (let round = 0; round <= targets.length; round++) {
    const seen = grid.reachable(start, (c) => isPassable(c) && c !== T.HAZARD);
    const bad = targets.find((t) => !seen[t]);
    if (bad === undefined) return;
    for (const c of bfsPath(grid, startIdx, bad)) if (grid.t[c] === T.HAZARD) grid.t[c] = T.FLOOR;
  }
}

function scatterDecor(grid: Grid, setting: ResolvedSetting, rng: MapRng, taken: ReadonlySet<number>, decor: Map<number, Material>): void {
  const props = setting.decorPool.filter((m) => !m.tags.includes("wall_mount"));
  const mounts = setting.decorPool.filter((m) => m.tags.includes("wall_mount"));
  const enclosed = setting.environment !== "outdoor";
  const rate = enclosed ? 0.025 : 0.035;
  if (props.length > 0) {
    for (let i = 0; i < grid.t.length; i++) {
      if (grid.t[i] !== T.FLOOR || taken.has(i) || decor.has(i)) continue;
      const x = i % grid.w;
      const y = (i - x) / grid.w;
      if (grid.border(x, y) || (enclosed && grid.room[i]! < 0)) continue;
      if (rng.chance(rate)) decor.set(i, props[Math.min(props.length - 1, Math.floor(rng.next() * props.length))]!);
    }
  }
  if (mounts.length > 0) {
    for (let i = 0; i < grid.t.length; i++) {
      if (grid.t[i] !== T.WALL) continue;
      const x = i % grid.w;
      const y = (i - x) / grid.w;
      if (y + 1 >= grid.h) continue;
      const below = grid.idx(x, y + 1);
      if (grid.t[below] === T.FLOOR && grid.room[below]! >= 0 && rng.chance(0.1)) decor.set(i, mounts[rng.int(0, mounts.length - 1)]!);
    }
  }
}

