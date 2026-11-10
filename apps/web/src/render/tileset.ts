import { PALETTE, paletteColorForGid } from "./palette";

export type TilePattern = "none" | "dots" | "stripes" | "cross";

export interface TileDesc {
  id: number;
  name?: string;
  layer?: string;
  color: string;
  pattern?: string;
  walkable?: boolean;
}

/** Shape of packages/engine/data/tileset-blocks.json (extra fields are ignored). */
export interface TilesetDesc {
  asset_id?: string;
  /** Global id of tile id 1. Tile `id` k has gid = first_gid + k - 1. Defaults to 1. */
  first_gid?: number;
  tiles: readonly TileDesc[];
}

export interface TileStyle {
  color: string;
  pattern: TilePattern;
  name: string;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const styles = new Map<number, TileStyle>();

function asPattern(p: string | undefined): TilePattern {
  return p === "dots" || p === "stripes" || p === "cross" ? p : "none";
}

/**
 * Install (or add) a tileset description. Call it once with the real tileset JSON when the server
 * delivers it (or import the JSON in the integrator's code); later calls add and override gids.
 * Tiles it does not know about keep falling back to a hashed palette color.
 */
export function setTileset(desc: TilesetDesc): void {
  const first = desc.first_gid ?? 1;
  for (const t of desc.tiles) {
    if (!HEX.test(t.color)) continue;
    styles.set(first + t.id - 1, { color: t.color, pattern: asPattern(t.pattern), name: t.name ?? `tile ${t.id}` });
  }
}

export function clearTileset(): void {
  styles.clear();
}

/** Style for a global tile id; unknown ids get a deterministic palette color. */
export function tileStyle(gid: number): TileStyle {
  return styles.get(gid) ?? { color: paletteColorForGid(gid), pattern: "none", name: `tile ${gid}` };
}

export function knownTileCount(): number {
  return styles.size;
}

export { PALETTE };
