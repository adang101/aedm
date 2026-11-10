/**
 * Tile assembly: turns the terrain grid plus the chosen decor into the map's tile layers and its inline tileset,
 * built only from the materials actually used (up to 3 visual variants per material, shifted along the same
 * palette ramp).
 */
import { MAX_TILEDEFS } from "@aedm/schemas";
import type { InlineTileset, Material, MaterialRole, Mood, TileDef } from "@aedm/schemas";
import { T } from "./layouts/grid";
import type { Grid } from "./layouts/grid";
import { getMaterial, resolveMaterial, shiftColor } from "./materials";
import type { ResolvedSetting } from "./settings";

export type TileLayerName = TileDef["layer"];

/** Integer hash to [0, 1). Deterministic and independent of call order. */
export function hash(seed: number, x: number, y: number, k = 0): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(x + 0x7f4a7c15, 0xc2b2ae35) ^ Math.imul(y + k * 0x165667b1 + 0x27d4eb2f, 0x27d4eb2d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1) with features about `scale` tiles wide. */
function vnoise(seed: number, x: number, y: number, scale: number): number {
  const gx = x / scale;
  const gy = y / scale;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(seed, x0, y0, 7);
  const b = hash(seed, x0 + 1, y0, 7);
  const c = hash(seed, x0, y0 + 1, 7);
  const d = hash(seed, x0 + 1, y0 + 1, 7);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Dark and eerie places read one ramp step darker. Custom (DM-made) materials keep exactly the colors the DM chose. */
const TONE: Record<Mood, number> = { bright: 0, neutral: 0, dim: 0, dark: -1, eerie: -1 };
const TONED_ROLES: ReadonlySet<MaterialRole> = new Set(["floor", "path", "wall", "obstacle", "liquid", "door"]);

const ROLE_INDEX: Record<MaterialRole, number> = { floor: 0, path: 1, wall: 2, obstacle: 3, liquid: 4, hazard: 5, decor: 6, door: 7 };
const LAYER_INDEX: Record<TileLayerName, number> = { ground: 0, walls: 1, decor: 2, above: 3 };

class TileBank {
  readonly tiles: TileDef[] = [];
  private readonly byKey = new Map<string, number>();

  constructor(private readonly tone: number) {}

  private colors(m: Material, role: MaterialRole, variant: number): { color: string; accent: string } {
    let { color, accent } = m;
    if (this.tone !== 0 && TONED_ROLES.has(role) && !m.id.startsWith("custom_")) {
      const c = shiftColor(color, this.tone);
      const a = shiftColor(accent, this.tone);
      // keep the original accent where the shift would merge color and accent and erase the pattern
      accent = c === a && m.color !== m.accent ? m.accent : a;
      color = c;
    }
    if (variant === 1) color = shiftColor(color, color === shiftColor(color, 1) ? -1 : 1);
    else if (variant === 2) color = shiftColor(color, color === shiftColor(color, -1) ? 1 : -1);
    else if (variant === 3) [color, accent] = [accent, color];
    return { color, accent };
  }

  /** Per material object: gid by role, layer and variant, so the hot loop never builds a key string. */
  private readonly fast = new Map<Material, Int32Array>();

  gid(m: Material, variant: number, layer: TileLayerName, role: MaterialRole = m.role): number {
    let slots = this.fast.get(m);
    if (!slots) this.fast.set(m, (slots = new Int32Array(8 * 4 * 4)));
    const slot = (ROLE_INDEX[role] * 4 + LAYER_INDEX[layer]) * 4 + variant;
    const cached = slots[slot]!;
    if (cached !== 0) return cached;
    const gid = this.slow(m, variant, layer, role);
    slots[slot] = gid;
    return gid;
  }

  private slow(m: Material, variant: number, layer: TileLayerName, role: MaterialRole): number {
    const base = this.colors(m, role, 0);
    let v = variant;
    let col = this.colors(m, role, v);
    if (v !== 0 && col.color === base.color && col.accent === base.accent) { v = 0; col = base; }
    const key = [m.id, role, layer, v, col.color, col.accent, m.pattern].join("|");
    const hit = this.byKey.get(key);
    if (hit !== undefined) return hit;
    if (this.tiles.length >= MAX_TILEDEFS) {
      const fallback = this.byKey.get([m.id, role, layer, 0, base.color, base.accent, m.pattern].join("|"));
      return fallback ?? this.tiles[0]!.gid;
    }
    const gid = this.tiles.length + 1;
    const wall = layer === "walls";
    this.tiles.push({
      gid,
      material_id: m.id,
      role,
      color: col.color,
      accent: col.accent,
      pattern: m.pattern,
      walkable: !wall,
      blocks_sight: wall && m.blocks_sight,
      variant: v,
      layer,
    });
    this.byKey.set(key, gid);
    return gid;
  }
}

export interface AssembleInput {
  grid: Grid;
  setting: ResolvedSetting;
  seed: number;
  /** Decor tiles: cell index to the prop material drawn there. */
  decor: ReadonlyMap<number, Material>;
}

export interface Assembled {
  tileset: InlineTileset;
  ground: number[];
  walls: number[];
  decor: number[];
  above: number[];
}

/** First index of a weighted pick: the first entry is the characteristic one. */
function pickWeighted(n: number, u: number, firstShare: number): number {
  if (n <= 1) return 0;
  if (u < firstShare) return 0;
  return 1 + Math.min(n - 2, Math.floor(((u - firstShare) / (1 - firstShare)) * (n - 1)));
}

const variantOf = (u: number, spread: number): number => (u < 1 - spread ? 0 : u < 1 - spread * 0.45 ? 1 : 2);

export function assemble({ grid, setting, seed, decor }: AssembleInput): Assembled {
  const { w, h } = grid;
  const n = w * h;
  const ground = new Array<number>(n).fill(0);
  const walls = new Array<number>(n).fill(0);
  const decorLayer = new Array<number>(n).fill(0);
  const above = new Array<number>(n).fill(0);
  const bank = new TileBank(TONE[setting.mood]);
  const mats = setting.materials;
  const deep = mats.liquid.filter((m) => !m.walkable);
  const shallow = mats.liquid.filter((m) => m.walkable);
  const deepList = deep.length > 0 ? deep : [getMaterial("water") ?? mats.liquid[0]!];
  const bridge =
    mats.path.find((m) => m.tags.includes("bridge")) ??
    resolveMaterial("plank_walkway", "path", { tags: [], mood: setting.mood });
  const door = mats.door;

  const floorAt = (x: number, y: number): number => {
    const list = mats.floor;
    const m = list[pickWeighted(list.length, vnoise(seed, x, y, 5), list.length === 2 ? 0.68 : 0.58)]!;
    return bank.gid(m, variantOf(hash(seed, x, y, 1), 0.26), "ground");
  };
  const liquidDepth = (x: number, y: number): boolean => {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const c = grid.get(x + dx, y + dy);
      if (c !== T.LIQUID) return false;
    }
    return true;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = grid.idx(x, y);
      const u = hash(seed, x, y, 2);
      switch (grid.t[i]) {
        case T.FLOOR:
          ground[i] = floorAt(x, y);
          break;
        case T.PATH: {
          const m = mats.path[pickWeighted(mats.path.length, u, 0.8)]!;
          ground[i] = bank.gid(m, variantOf(hash(seed, x, y, 3), 0.3), "ground");
          break;
        }
        case T.BRIDGE:
          ground[i] = bank.gid(bridge, variantOf(hash(seed, x, y, 3), 0.2), "ground", "path");
          break;
        case T.DOOR:
          ground[i] = bank.gid(door[pickWeighted(door.length, u, 0.8)]!, 0, "ground", "door");
          break;
        case T.HAZARD: {
          const list = mats.hazard;
          ground[i] = bank.gid(list[grid.haz[i]! % list.length]!, 0, "ground", "hazard");
          break;
        }
        case T.SHALLOW:
          ground[i] = shallow.length > 0 ? bank.gid(shallow[pickWeighted(shallow.length, u, 0.7)]!, 0, "ground", "liquid") : floorAt(x, y);
          break;
        case T.WALL: {
          const m = mats.wall[pickWeighted(mats.wall.length, u, 0.78)]!;
          walls[i] = bank.gid(m, variantOf(hash(seed, x, y, 3), 0.3), "walls");
          break;
        }
        case T.OBSTACLE: {
          ground[i] = floorAt(x, y);
          const list = mats.obstacle;
          const m = list[pickWeighted(list.length, u, 0.5)]!;
          walls[i] = bank.gid(m, hash(seed, x, y, 3) < 0.2 ? 1 : 0, "walls");
          if (m.tags.includes("tree") && hash(seed, x, y, 4) < 0.22) {
            const top: Material = { ...m, id: `${m.id.slice(0, 24)}_canopy`, blocks_sight: false, walkable: true };
            above[i] = bank.gid(top, 1, "above", "obstacle");
          }
          break;
        }
        case T.LIQUID: {
          ground[i] = floorAt(x, y);
          const m = deepList.length > 1 && liquidDepth(x, y) ? deepList[1]! : deepList[0]!;
          walls[i] = bank.gid(m, 0, "walls", "liquid");
          break;
        }
        default:
          break;
      }
    }
  }
  for (const [i, m] of decor) decorLayer[i] = bank.gid(m, 0, "decor", m.role);

  // drop tile definitions nothing uses, renumbering the rest densely
  const used = new Set<number>();
  for (const layer of [ground, walls, decorLayer, above]) for (const g of layer) if (g !== 0) used.add(g);
  const remap = new Map<number, number>();
  const tiles: TileDef[] = [];
  for (const t of bank.tiles) {
    if (!used.has(t.gid)) continue;
    remap.set(t.gid, tiles.length + 1);
    tiles.push({ ...t, gid: tiles.length + 1 });
  }
  const apply = (layer: number[]): number[] => layer.map((g) => (g === 0 ? 0 : remap.get(g)!));
  return {
    tileset: { first_gid: 1, tiles: tiles.length > 0 ? tiles : bank.tiles.slice(0, 1) },
    ground: apply(ground),
    walls: apply(walls),
    decor: apply(decorLayer),
    above: apply(above),
  };
}
