import type { Biome } from "@aedm/schemas";
import data from "../../data/tileset-blocks.json";

export type TileLayerKind = "ground" | "walls" | "decor" | "above";
export type TilePattern = "dots" | "stripes" | "cross" | "none";

export interface BlockTile {
  /** 1-based; gid = first_gid + id - 1. */
  id: number;
  name: string;
  biomes: Biome[];
  layer: TileLayerKind;
  color: string;
  pattern?: TilePattern;
  walkable: boolean;
}

export interface BlockTileset {
  asset_id: string;
  first_gid: number;
  tile_size: number;
  note: string;
  tiles: BlockTile[];
}

export const TILESET_BLOCKS = data as unknown as BlockTileset;

const byName = new Map<string, BlockTile>(TILESET_BLOCKS.tiles.map((t) => [t.name, t]));

/** Tile metadata for a global tile id, or undefined for 0 / out of range. */
export function tileInfo(gid: number): BlockTile | undefined {
  return TILESET_BLOCKS.tiles[gid - TILESET_BLOCKS.first_gid];
}

/** Global tile id for a tile name. Throws on unknown names. */
export function gidOf(name: string): number {
  const t = byName.get(name);
  if (!t) throw new Error(`unknown tile ${name}`);
  return TILESET_BLOCKS.first_gid + t.id - 1;
}

export function hasTile(name: string): boolean {
  return byName.has(name);
}

/** Number of tiles in the placeholder tileset. */
export const TILESET_BLOCKS_COUNT = TILESET_BLOCKS.tiles.length;
