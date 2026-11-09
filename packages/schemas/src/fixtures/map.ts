/** A minimal structurally valid 20x20 map (not semantically validated). */
export function makeMap(w = 20, h = 20) {
  const data = () => new Array(w * h).fill(0);
  return {
    v: 1, id: "m_lighthouse", width: w, height: h, tile_size: 48,
    tilesets: [{ asset_id: "ts_dungeon", first_gid: 1 }],
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
    meta: { biome: "interior", theme_tags: [], seed: 42, generated_at: "2026-01-01T00:00:00Z" },
  };
}
