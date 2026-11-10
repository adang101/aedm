import type { EntityView, GameMap, MapObject } from "@aedm/schemas";
import type { TilesetDesc } from "../render/tileset";

export const MOCK_W = 30;
export const MOCK_H = 20;

/** Stand-in for tileset-blocks.json, sent to the renderer in mock mode. */
export const MOCK_TILESET: TilesetDesc = {
  asset_id: "ts_blocks",
  first_gid: 1,
  tiles: [
    { id: 1, name: "grass", color: "#4f8a3c", pattern: "dots" },
    { id: 2, name: "flagstone", color: "#8b93b0", pattern: "cross" },
    { id: 3, name: "stone_wall", color: "#5c6380", pattern: "none" },
    { id: 4, name: "marsh_water", color: "#2f6bb5", pattern: "stripes" },
    { id: 5, name: "dirt_path", color: "#9a6a3f", pattern: "dots" },
    { id: 6, name: "barrel", color: "#70472f", pattern: "stripes" },
    { id: 7, name: "door", color: "#c99a63", pattern: "stripes" },
    { id: 8, name: "torch", color: "#f5a65b", pattern: "none" },
    { id: 9, name: "bush", color: "#2f5d34", pattern: "dots" },
    { id: 10, name: "crate", color: "#c99a3a", pattern: "cross" },
    { id: 11, name: "planks", color: "#c99a63", pattern: "stripes" },
  ],
};

const G = { grass: 1, flag: 2, wall: 3, water: 4, path: 5, barrel: 6, door: 7, torch: 8, bush: 9, crate: 10, plank: 11 };

export function buildMockMap(): GameMap {
  const n = MOCK_W * MOCK_H;
  const ground = new Array<number>(n).fill(G.grass);
  const walls = new Array<number>(n).fill(0);
  const decor = new Array<number>(n).fill(0);
  const at = (x: number, y: number) => y * MOCK_W + x;
  const fill = (arr: number[], x0: number, y0: number, x1: number, y1: number, v: number) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) arr[at(x, y)] = v;
  };

  fill(ground, 9, 6, 20, 13, G.flag); // plaza
  fill(ground, 1, 10, 8, 10, G.path); // road west
  fill(ground, 21, 10, 28, 10, G.path); // road east
  fill(ground, 14, 3, 14, 5, G.path); // road north
  fill(ground, 4, 4, 7, 6, G.plank); // inn floor
  fill(ground, 24, 15, 28, 18, G.water); // marsh

  // border walls with a gap at the west exit
  for (let x = 0; x < MOCK_W; x++) { walls[at(x, 0)] = G.wall; walls[at(x, MOCK_H - 1)] = G.wall; }
  for (let y = 0; y < MOCK_H; y++) { walls[at(0, y)] = G.wall; walls[at(MOCK_W - 1, y)] = G.wall; }
  walls[at(0, 10)] = 0;

  // the inn (x3..8, y3..7) with a door gap
  fill(walls, 3, 3, 8, 3, G.wall); fill(walls, 3, 7, 8, 7, G.wall);
  fill(walls, 3, 3, 3, 7, G.wall); fill(walls, 8, 3, 8, 7, G.wall);
  walls[at(5, 7)] = 0;
  decor[at(5, 7)] = G.door;
  // a ruined tower (x23..27, y2..5)
  fill(walls, 23, 2, 27, 2, G.wall); fill(walls, 23, 5, 27, 5, G.wall);
  fill(walls, 23, 2, 23, 5, G.wall); fill(walls, 27, 2, 27, 5, G.wall);
  walls[at(25, 5)] = 0;
  decor[at(25, 5)] = G.door;

  for (const [x, y] of [[4, 4], [7, 6], [10, 7], [19, 7], [11, 12], [18, 12]] as const) decor[at(x, y)] = G.barrel;
  for (const [x, y] of [[9, 8], [20, 8], [9, 11], [20, 11]] as const) decor[at(x, y)] = G.torch;
  for (const [x, y] of [[2, 14], [3, 15], [12, 16], [13, 17], [27, 8], [26, 9], [6, 2], [18, 2]] as const) decor[at(x, y)] = G.bush;
  for (const [x, y] of [[6, 5], [24, 3]] as const) decor[at(x, y)] = G.crate;

  const objects: MapObject[] = [
    { type: "spawn", name: "party_start", x: 13, y: 10 },
    { type: "exit", name: "road_west", to: "pending", target_entry: "party_start", x: 0, y: 10 },
    { type: "entity_slot", id: "slot_choir", role: "enemy", count: 2, x: 22, y: 11 },
    { type: "interactable", id: "chest_plaza", kind: "chest", state: "locked", x: 19, y: 13 },
    { type: "interactable", id: "sign_square", kind: "sign", state: "closed", x: 15, y: 6 },
    { type: "interactable", id: "door_inn", kind: "door", state: "open", x: 5, y: 7 },
    { type: "trigger", id: "trg_marsh", radius: 2, on_enter: "marsh_whispers", x: 24, y: 14 },
  ];

  return {
    v: 1, id: "m_hollowmere", width: MOCK_W, height: MOCK_H, tile_size: 48,
    tilesets: [{ asset_id: "ts_blocks", first_gid: 1 }],
    layers: [
      { type: "tilelayer", name: "ground", data: ground },
      { type: "tilelayer", name: "walls", data: walls },
      { type: "tilelayer", name: "decor", data: decor },
      { type: "tilelayer", name: "above", data: new Array<number>(n).fill(0) },
      { type: "objectgroup", name: "objects", objects },
    ],
    meta: { biome: "town", theme_tags: ["marsh", "dusk"], seed: 1337, generated_at: "2026-01-01T00:00:00Z" },
  };
}

export function wallAt(map: GameMap, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return true;
  const l = map.layers.find((k) => k.type === "tilelayer" && k.name === "walls");
  return !!l && l.type === "tilelayer" && (l.data[y * map.width + x] ?? 0) !== 0;
}

export const NPC_ODALYS: EntityView = {
  id: "npc_odalys", kind: "npc", name: "Odalys", x: 16, y: 8, hp: 8, hp_max: 8, conditions: [],
  sprite: { kind: "shape", shape: "square", color: "#c99a3a", accent: "#4a2f24", glyph: "Od" }, disposition: "friendly",
};

export function choristerEntities(): EntityView[] {
  const sprite = { kind: "shape" as const, shape: "diamond" as const, color: "#6a45a8", accent: "#cbb0f0", glyph: "C" };
  return [
    { id: "en_chorister_1", kind: "enemy", name: "Robed Chorister", x: 22, y: 11, hp: 10, hp_max: 10, conditions: [], sprite, disposition: "hostile" },
    { id: "en_chorister_2", kind: "enemy", name: "Robed Chorister", x: 23, y: 9, hp: 10, hp_max: 10, conditions: [], sprite, disposition: "hostile" },
  ];
}

export const NARRATION_OPENING =
  "Dusk settles over Hollowmere like a damp wool blanket. Lanterns gutter along the village square, and " +
  "somewhere beyond the reeds a low, wordless humming drifts in from the marsh. Odalys the innkeeper pauses " +
  "mid-sweep on the porch of the Drowned Lantern, watching you with a wary, hopeful look. At the far side " +
  "of the square, two figures in grey robes stand perfectly still, mouths slightly open, as if listening.";
