/**
 * COMPATIBILITY SHIM (remove when the new generator lands).
 * The old generator still builds maps from the placeholder block tileset and a legacy biome. These helpers
 * turn a v2 setting into that biome and the block tileset into a v2 inline tileset (same gids).
 */
import { snapToPalette, type Biome, type InlineTileset, type MapBrief, type MaterialRole, type SettingPreset, type TileDef } from "@aedm/schemas";
import { TILESET_BLOCKS, type BlockTile } from "./tileset";

const PRESET_BIOME: Record<SettingPreset, Biome> = {
  forest: "forest", swamp: "forest", snowfield: "forest", farmland: "forest",
  desert: "desert", beach: "desert", mountain_pass: "desert",
  dungeon: "dungeon", cave: "dungeon", sewer: "dungeon", crypt: "dungeon", volcanic: "dungeon", ruins: "dungeon",
  town: "town", market: "town",
  interior: "interior", library: "interior", temple: "interior", castle: "interior", ship_deck: "interior",
};

/** The old biome a setting maps to: by preset, else by layout and environment. */
export function legacyBiome(setting: MapBrief["setting"]): Biome {
  if (setting.preset) return PRESET_BIOME[setting.preset];
  if (setting.layout === "settlement") return "town";
  if (setting.environment === "indoor") return "interior";
  if (setting.environment === "underground") return "dungeon";
  return "forest";
}

function roleOf(t: BlockTile): MaterialRole {
  if (t.layer === "ground") {
    if (t.name.startsWith("door")) return "door";
    if (/path|road/.test(t.name)) return "path";
    return "floor";
  }
  if (t.layer === "walls") {
    if (t.name === "water") return "liquid";
    return /^wall_|building_wall/.test(t.name) ? "wall" : "obstacle";
  }
  return "decor";
}

const mix = (hex: string): string => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return snapToPalette(`#${c.map((v) => Math.round(v + (255 - v) * 0.3).toString(16).padStart(2, "0")).join("")}`);
};

const PATTERNS: ReadonlySet<string> = new Set(["none", "dots", "stripes", "cross"]);

let cached: InlineTileset | undefined;

/** The placeholder block tileset as a v2 inline tileset: same gids as `tileset-blocks.json`. */
export function legacyInlineTileset(): InlineTileset {
  cached ??= {
    first_gid: 1,
    tiles: TILESET_BLOCKS.tiles.map((t): TileDef => {
      const role = roleOf(t);
      return {
        gid: TILESET_BLOCKS.first_gid + t.id - 1,
        material_id: t.name,
        role,
        color: t.color,
        accent: mix(t.color),
        pattern: PATTERNS.has(t.pattern ?? "none") ? (t.pattern as TileDef["pattern"]) : "none",
        walkable: t.walkable,
        blocks_sight: role === "wall",
        variant: Math.min(3, Math.max(0, Number(/_(\d)$/.exec(t.name)?.[1] ?? 1) - 1)),
        layer: t.layer,
      };
    }),
  };
  return structuredClone(cached);
}
