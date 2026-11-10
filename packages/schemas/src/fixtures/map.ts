/** The inline tileset of the fixture map: gid 1 is a wall, 2 a floor, 3 a decor prop. */
export const FIXTURE_TILES = [
  { gid: 1, material_id: "stone_wall", role: "wall", color: "#3b3f55", accent: "#5c6380", pattern: "bricks", walkable: false, blocks_sight: true, variant: 0, layer: "walls" },
  { gid: 2, material_id: "stone_floor", role: "floor", color: "#5c6380", accent: "#8b93b0", pattern: "tiles", walkable: true, blocks_sight: false, variant: 0, layer: "ground" },
  { gid: 3, material_id: "barrel", role: "decor", color: "#70472f", accent: "#c99a63", pattern: "planks", walkable: true, blocks_sight: false, variant: 0, layer: "decor" },
] as const;

/** A minimal structurally valid v2 20x20 map (not semantically validated). Layers are empty. */
export function makeMap(w = 20, h = 20) {
  const data = () => new Array(w * h).fill(0);
  return {
    v: 2, id: "m_lighthouse", width: w, height: h, tile_size: 48,
    tileset: { first_gid: 1, tiles: FIXTURE_TILES.map((t) => ({ ...t })) },
    layers: [
      { type: "tilelayer", name: "ground", data: data() },
      { type: "tilelayer", name: "walls", data: data() },
      { type: "tilelayer", name: "decor", data: data() },
      { type: "tilelayer", name: "above", data: data() },
      {
        type: "objectgroup", name: "objects",
        objects: [
          { type: "spawn", name: "party_start", x: 2, y: 2 },
          { type: "exit", name: "door", to: "pending", target_entry: "party_start", x: 0, y: 5 },
          { type: "entity_slot", id: "slot_1", role: "enemy", count: 2, x: 10, y: 10 },
          { type: "interactable", id: "desk", kind: "chest", state: "closed", x: 8, y: 3 },
          { type: "trigger", id: "t1", radius: 2, on_enter: "creak", x: 5, y: 5 },
        ],
      },
    ],
    meta: { setting: { name: "Lighthouse interior", preset: "interior", layout: "rooms_and_corridors", environment: "indoor", mood: "dim" }, theme_tags: [], seed: 42, generated_at: "2026-01-01T00:00:00Z" },
  };
}
