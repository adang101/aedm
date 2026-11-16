import type { ContainerSummary, EntityView, GameMap, MapObject, TileDef } from "@aedm/schemas";
import { TILE, scaleOf, type Camera } from "../render/camera";
import { mixHex, parseHex } from "../render/palette";
import type { SeenGrid } from "./seen";

/**
 * Pure helpers behind the minimap: how a tile is reduced to a colour, how a creature or object becomes a marker,
 * and how clicks and the camera map between minimap pixels and tiles. Only data the client received is used.
 */

export type TileClass = "ground" | "path" | "water" | "hazard" | "wall" | "obstacle" | "door" | "void";

export function tileDefs(map: Pick<GameMap, "tileset">): Map<number, TileDef> {
  return new Map(map.tileset.tiles.map((t) => [t.gid, t]));
}

function layer(map: GameMap, name: string): number[] {
  const l = map.layers.find((x) => x.type === "tilelayer" && x.name === name);
  return l && l.type === "tilelayer" ? l.data : [];
}

/** Which kind of tile a cell reads as, and the definition whose colour it takes. Walls and props win over the ground below. */
export function classifyTile(ground: TileDef | undefined, wall: TileDef | undefined, decor: TileDef | undefined): { cls: TileClass; def: TileDef | undefined } {
  for (const d of [wall, decor]) {
    if (!d) continue;
    if (d.role === "wall") return { cls: "wall", def: d };
    if (d.role === "door") return { cls: "door", def: d };
    if (d.role === "obstacle") return { cls: "obstacle", def: d };
  }
  if (!ground) return { cls: "void", def: undefined };
  switch (ground.role) {
    case "liquid": return { cls: "water", def: ground };
    case "hazard": return { cls: "hazard", def: ground };
    case "path": return { cls: "path", def: ground };
    case "wall": return { cls: "wall", def: ground };
    case "obstacle": return { cls: "obstacle", def: ground };
    case "door": return { cls: "door", def: ground };
    default: return { cls: "ground", def: ground };
  }
}

const VOID = "#120d1b";

/** One readable colour per class, tinted by the tile's own colour so a map keeps its look. */
export function tileColor(cls: TileClass, def: TileDef | undefined): string {
  const c = def?.color ?? VOID;
  switch (cls) {
    case "void": return VOID;
    case "ground": return mixHex(c, "#1b1626", 0.25);
    case "path": return mixHex(c, "#fff0bd", 0.55);
    case "water": return mixHex(c, "#3f7fc4", 0.6);
    case "hazard": return mixHex(c, "#e0452f", 0.65);
    case "wall": return mixHex(c, "#0f0b17", 0.7);
    case "obstacle": return mixHex(c, "#0f2a19", 0.55);
    case "door": return mixHex(c, "#c8934d", 0.6);
  }
}

/** How much of the unseen tiles' colour is replaced by the backdrop. */
export const UNSEEN_DIM = 0.5;

/** RGBA pixels, one per tile, for the whole map. `seen` dims tiles the party has not been near; null shows everything. */
export function rasterizeMap(map: GameMap, seen: SeenGrid | null): Uint8ClampedArray {
  const w = map.width, h = map.height;
  const defs = tileDefs(map);
  const ground = layer(map, "ground"), walls = layer(map, "walls"), decor = layer(map, "decor");
  const out = new Uint8ClampedArray(w * h * 4);
  const cache = new Map<string, [number, number, number]>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const { cls, def } = classifyTile(defs.get(ground[i] ?? 0), defs.get(walls[i] ?? 0), defs.get(decor[i] ?? 0));
      const dim = seen && !seen.isSeen(x, y);
      const key = `${cls}:${def?.gid ?? 0}:${dim ? 1 : 0}`;
      let rgb = cache.get(key);
      if (!rgb) {
        const hex = tileColor(cls, def);
        rgb = parseHex(dim ? mixHex(hex, VOID, UNSEEN_DIM) : hex);
        cache.set(key, rgb);
      }
      out[i * 4] = rgb[0]; out[i * 4 + 1] = rgb[1]; out[i * 4 + 2] = rgb[2]; out[i * 4 + 3] = 255;
    }
  }
  return out;
}

// ---------- creatures ----------

export type DotShape = "me" | "ally" | "friendly" | "neutral" | "wary" | "hostile";

export interface Dot {
  id: string;
  x: number;
  y: number;
  shape: DotShape;
  color: string;
  label: string;
}

export const DOT_STYLE: Record<DotShape, { color: string; label: string }> = {
  me: { color: "#ffe27a", label: "You" },
  ally: { color: "#6fc3ff", label: "Party" },
  friendly: { color: "#7be08a", label: "Friendly" },
  neutral: { color: "#cfd4e6", label: "Neutral" },
  wary: { color: "#ffab40", label: "Wary" },
  hostile: { color: "#ff5a4a", label: "Hostile" },
};

/** Party members are circles (yours has a ring), hostile creatures triangles, wary ones diamonds, others squares. */
export function classifyCreature(e: EntityView, myId: string | null): DotShape {
  if (e.kind === "pc") return e.id === myId ? "me" : "ally";
  const d = e.disposition ?? (e.kind === "enemy" ? "hostile" : "neutral");
  return d;
}

/** Everything alive that the client was told about, as dots. Defeated creatures are left out. */
export function creatureDots(entities: Record<string, EntityView>, myId: string | null): Dot[] {
  const out: Dot[] = [];
  for (const e of Object.values(entities)) {
    if (e.hp <= 0) continue;
    const shape = classifyCreature(e, myId);
    out.push({ id: e.id, x: e.x, y: e.y, shape, color: DOT_STYLE[shape].color, label: e.name });
  }
  // draw order: others first, the player's own dot last so it is never hidden
  const rank: Record<DotShape, number> = { neutral: 0, friendly: 1, wary: 2, hostile: 3, ally: 4, me: 5 };
  return out.sort((a, b) => rank[a.shape] - rank[b.shape]);
}

// ---------- objects ----------

export type MarkerKind = "exit" | "chest" | "door" | "lever" | "sign" | "altar" | "trap" | "pile" | "landmark";
export type Side = "n" | "s" | "e" | "w";

export interface Marker {
  kind: MarkerKind;
  x: number;
  y: number;
  /** Exits only: the map edge the exit sits on. */
  side?: Side;
  label: string;
}

/** The edge an exit is nearest to (ties go north, south, west, east). */
export function exitSide(x: number, y: number, w: number, h: number): Side {
  const d: [Side, number][] = [["n", y], ["s", h - 1 - y], ["w", x], ["e", w - 1 - x]];
  let best = d[0]!;
  for (const c of d) if (c[1] < best[1]) best = c;
  return best[0];
}

/** Landmarks, exits, interactables and loot piles present in the data the client holds. Hidden objects are never included. */
export function collectMarkers(
  map: GameMap, objects: readonly MapObject[], containers: readonly ContainerSummary[],
  landmarks: readonly { name: string; x: number; y: number }[] = [],
): Marker[] {
  const out: Marker[] = [];
  // landmarks first, so anything standing on one is drawn over its glyph
  for (const l of landmarks) out.push({ kind: "landmark", x: l.x, y: l.y, label: l.name });
  const taken = new Set<string>();
  for (const o of objects) {
    if (o.type === "exit") {
      out.push({ kind: "exit", x: o.x, y: o.y, side: exitSide(o.x, o.y, map.width, map.height), label: o.name });
    } else if (o.type === "interactable" && !o.hidden) {
      out.push({ kind: o.kind, x: o.x, y: o.y, label: o.kind });
      taken.add(`${o.x},${o.y}`);
    }
  }
  for (const c of containers) {
    if (c.kind === "chest" || c.kind === "pockets" || taken.has(`${c.x},${c.y}`)) continue;
    out.push({ kind: "pile", x: c.x, y: c.y, label: c.kind });
  }
  return out;
}

// ---------- geometry ----------

export interface MinimapSize { k: number; width: number; height: number }

/** Integer pixels per tile so tiles stay crisp: the largest k that fits the box (at least `minK`). */
export function fitMinimap(mapW: number, mapH: number, boxW: number, boxH: number, minK = 2, maxK = 12): MinimapSize {
  const k = Math.max(minK, Math.min(maxK, Math.floor(Math.min(boxW / mapW, boxH / mapH))));
  return { k, width: mapW * k, height: mapH * k };
}

/** A point on the minimap (CSS pixels from its top-left) as a fractional tile position, kept inside the map. */
export function minimapToTilePos(px: number, py: number, k: number, mapW: number, mapH: number): { x: number; y: number } {
  const clamp = (v: number, max: number) => Math.min(max - 0.001, Math.max(0, v));
  return { x: clamp(px / k, mapW), y: clamp(py / k, mapH) };
}

/** The camera centre (world pixels) that centres a clicked minimap point. */
export function minimapToCameraCenter(px: number, py: number, k: number, mapW: number, mapH: number): { cx: number; cy: number } {
  const t = minimapToTilePos(px, py, k, mapW, mapH);
  return { cx: t.x * TILE, cy: t.y * TILE };
}

/** The whole tile under a minimap point (for walking there). */
export function minimapToTile(px: number, py: number, k: number, mapW: number, mapH: number): { x: number; y: number } {
  const t = minimapToTilePos(px, py, k, mapW, mapH);
  return { x: Math.floor(t.x), y: Math.floor(t.y) };
}

/** The part of the map the main view shows, in tile units, clamped to the map. */
export function viewRect(cam: Camera, viewW: number, viewH: number, mapW: number, mapH: number): { x0: number; y0: number; x1: number; y1: number } {
  const s = scaleOf(viewW, cam);
  const halfW = viewW / s / 2 / TILE, halfH = viewH / s / 2 / TILE;
  const cx = cam.cx / TILE, cy = cam.cy / TILE;
  return {
    x0: Math.max(0, cx - halfW), y0: Math.max(0, cy - halfH),
    x1: Math.min(mapW, cx + halfW), y1: Math.min(mapH, cy + halfH),
  };
}
