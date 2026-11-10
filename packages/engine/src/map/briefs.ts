import type { Biome, MapBrief } from "@aedm/schemas";

/** Ready-made briefs, used when a campaign starts before the DM has generated any map. */
export const STARTER_BRIEFS: Record<Biome, MapBrief> = {
  town: {
    setting: { name: "Harbor town", preset: "town", layout: "settlement", environment: "outdoor", mood: "neutral" },
    theme_tags: ["coastal", "fog"],
    size_class: "medium",
    rooms: [
      { id: "square", type: "outdoor", size: "large", connects_to: ["inn_yard", "harbor"] },
      { id: "inn_yard", type: "courtyard", size: "small", connects_to: ["square"] },
      { id: "harbor", type: "outdoor", size: "medium", connects_to: ["square", "lighthouse_road"] },
      { id: "lighthouse_road", type: "outdoor", size: "small", connects_to: ["harbor"] },
    ],
    points_of_interest: [
      { kind: "well", room_id: "square" },
      { kind: "sign", room_id: "square" },
      { kind: "door", room_id: "inn_yard" },
      { kind: "barrel", room_id: "harbor" },
    ],
    entity_slots: [
      { role: "npc", room_id: "square", count: 2 },
      { role: "npc", room_id: "inn_yard", count: 1 },
    ],
    exits: [
      { side: "north", label: "Lighthouse Road" },
      { side: "east", label: "Marsh Path" },
    ],
  },
  forest: {
    setting: { name: "Marsh forest", preset: "forest", layout: "open_field", environment: "outdoor", mood: "dim" },
    theme_tags: ["marsh", "fog"],
    size_class: "medium",
    rooms: [
      { id: "clearing", type: "outdoor", size: "medium", connects_to: ["pond_edge", "ruin"] },
      { id: "pond_edge", type: "outdoor", size: "small", connects_to: ["clearing"] },
      { id: "ruin", type: "cave", size: "medium", connects_to: ["clearing"] },
    ],
    points_of_interest: [
      { kind: "statue", room_id: "ruin" },
      { kind: "chest", room_id: "ruin" },
      { kind: "mushroom", room_id: "pond_edge" },
    ],
    entity_slots: [
      { role: "enemy", room_id: "clearing", count: 3 },
      { role: "loot", room_id: "ruin", count: 1 },
    ],
    exits: [
      { side: "west", label: "Road to Hollowmere" },
      { side: "east", label: "Deeper Marsh" },
    ],
  },
  dungeon: {
    setting: { name: "Old crypt", preset: "dungeon", layout: "rooms_and_corridors", environment: "underground", mood: "dark" },
    theme_tags: ["crypt"],
    size_class: "medium",
    rooms: [
      { id: "entry", type: "chamber", size: "small", connects_to: ["hall"] },
      { id: "hall", type: "hall", size: "medium", connects_to: ["entry", "crypt", "cavern"] },
      { id: "crypt", type: "chamber", size: "large", connects_to: ["hall", "vault"] },
      { id: "vault", type: "chamber", size: "small", connects_to: ["crypt"] },
      { id: "cavern", type: "cave", size: "medium", connects_to: ["hall"] },
    ],
    points_of_interest: [
      { kind: "altar", room_id: "crypt" },
      { kind: "lever", room_id: "hall" },
      { kind: "chest", room_id: "vault" },
      { kind: "statue", room_id: "entry" },
    ],
    entity_slots: [
      { role: "enemy", room_id: "hall", count: 3 },
      { role: "boss", room_id: "crypt", count: 1 },
      { role: "loot", room_id: "vault", count: 1 },
    ],
    exits: [{ side: "north", label: "Stairs Up" }],
  },
  desert: {
    setting: { name: "Dune oasis", preset: "desert", layout: "open_field", environment: "outdoor", mood: "bright" },
    theme_tags: ["dunes"],
    size_class: "medium",
    rooms: [
      { id: "oasis", type: "outdoor", size: "medium", connects_to: ["ruins", "camp"] },
      { id: "ruins", type: "outdoor", size: "medium", connects_to: ["oasis"] },
      { id: "camp", type: "outdoor", size: "small", connects_to: ["oasis"] },
    ],
    points_of_interest: [
      { kind: "well", room_id: "oasis" },
      { kind: "statue", room_id: "ruins" },
      { kind: "chest", room_id: "ruins" },
    ],
    entity_slots: [
      { role: "enemy", room_id: "ruins", count: 3 },
      { role: "npc", room_id: "camp", count: 1 },
    ],
    exits: [
      { side: "south", label: "Caravan Road" },
      { side: "west", label: "Dry Riverbed" },
    ],
  },
  interior: {
    setting: { name: "Lighthouse interior", preset: "interior", layout: "rooms_and_corridors", environment: "indoor", mood: "dim" },
    theme_tags: ["lighthouse"],
    size_class: "small",
    rooms: [
      { id: "ground_floor", type: "chamber", size: "medium", connects_to: ["stairwell", "keeper_room"] },
      { id: "stairwell", type: "corridor", size: "small", connects_to: ["ground_floor", "cellar", "lamp_room"] },
      { id: "keeper_room", type: "chamber", size: "small", connects_to: ["ground_floor"] },
      { id: "cellar", type: "chamber", size: "medium", connects_to: ["stairwell"] },
      { id: "lamp_room", type: "chamber", size: "small", connects_to: ["stairwell"] },
    ],
    points_of_interest: [
      { kind: "chest", room_id: "keeper_room" },
      { kind: "door", room_id: "cellar" },
      { kind: "table", room_id: "ground_floor" },
      { kind: "lever", room_id: "lamp_room" },
    ],
    entity_slots: [{ role: "enemy", room_id: "cellar", count: 2 }],
    exits: [{ side: "south", label: "Lighthouse Door" }],
  },
};
