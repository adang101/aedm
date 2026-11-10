import { SETTING_PRESETS } from "@aedm/schemas";
import type { Layout, MapBrief, Room, SettingPreset } from "@aedm/schemas";
import { SETTING_PRESET_DATA } from "./settings";

type RoomSpec = [id: string, type: Room["type"], size: Room["size"], connects: string[]];

/** Room plans per layout; the first room is where the party starts. */
const PLANS: Record<Layout, { rooms: RoomSpec[]; poi: string[]; enemies: string; boss: string; loot: string; npc: string }> = {
  rooms_and_corridors: {
    rooms: [["entry", "chamber", "small", ["hall"]], ["hall", "hall", "medium", ["entry", "main", "side"]], ["main", "chamber", "large", ["hall", "vault"]], ["vault", "chamber", "small", ["main"]], ["side", "chamber", "medium", ["hall"]]],
    poi: ["main", "hall", "vault", "entry"], enemies: "hall", boss: "main", loot: "vault", npc: "entry",
  },
  cave: {
    rooms: [["mouth", "cave", "small", ["cavern"]], ["cavern", "cave", "large", ["mouth", "hollow", "nook"]], ["hollow", "cave", "medium", ["cavern"]], ["nook", "cave", "small", ["cavern"]]],
    poi: ["hollow", "nook", "cavern"], enemies: "cavern", boss: "hollow", loot: "nook", npc: "mouth",
  },
  open_field: {
    rooms: [["clearing", "outdoor", "medium", ["edge", "landmark"]], ["edge", "outdoor", "small", ["clearing"]], ["landmark", "outdoor", "medium", ["clearing"]]],
    poi: ["landmark", "landmark", "edge"], enemies: "clearing", boss: "landmark", loot: "landmark", npc: "edge",
  },
  settlement: {
    rooms: [["square", "outdoor", "large", ["yard", "lane"]], ["yard", "courtyard", "small", ["square"]], ["lane", "street", "medium", ["square", "edge"]], ["edge", "outdoor", "small", ["lane"]]],
    poi: ["square", "square", "yard", "lane"], enemies: "edge", boss: "edge", loot: "yard", npc: "square",
  },
  trail: {
    rooms: [["start", "outdoor", "small", ["bend"]], ["bend", "outdoor", "medium", ["start", "overlook"]], ["overlook", "outdoor", "medium", ["bend", "end"]], ["end", "outdoor", "small", ["overlook"]]],
    poi: ["bend", "overlook", "end"], enemies: "overlook", boss: "end", loot: "end", npc: "start",
  },
  arena: {
    rooms: [["arena", "courtyard", "large", ["east", "west"]], ["east", "chamber", "small", ["arena"]], ["west", "chamber", "small", ["arena"]]],
    poi: ["arena", "east", "west"], enemies: "arena", boss: "arena", loot: "east", npc: "west",
  },
  maze: {
    rooms: [["entrance", "chamber", "small", ["heart"]], ["heart", "chamber", "large", ["entrance", "nook"]], ["nook", "chamber", "small", ["heart"]], ["cache", "vault", "small", ["heart"]]],
    poi: ["heart", "nook", "cache"], enemies: "heart", boss: "heart", loot: "cache", npc: "entrance",
  },
  islands: {
    rooms: [["landing", "shore", "large", ["cove", "reef"]], ["cove", "shore", "medium", ["landing"]], ["reef", "shore", "small", ["landing", "far"]], ["far", "shore", "medium", ["reef"]]],
    poi: ["cove", "far", "landing"], enemies: "landing", boss: "far", loot: "far", npc: "landing",
  },
};

const PEACEFUL: ReadonlySet<SettingPreset> = new Set(["town", "market", "farmland", "interior", "library"]);

function starterBrief(preset: SettingPreset): MapBrief {
  const d = SETTING_PRESET_DATA[preset];
  const plan = PLANS[d.layout];
  const peaceful = PEACEFUL.has(preset);
  return {
    setting: { name: d.starter.name, preset, layout: d.layout, environment: d.environment, mood: d.mood },
    theme_tags: [...d.starter.tags],
    size_class: preset === "interior" || preset === "library" ? "small" : "medium",
    rooms: plan.rooms.map(([id, type, size, connects_to]) => ({ id, type, size, connects_to })),
    points_of_interest: d.starter.pois.map((kind, i) => ({ kind, room_id: plan.poi[i % plan.poi.length]! })),
    entity_slots: peaceful
      ? [{ role: "npc" as const, room_id: plan.npc, count: 2 }]
      : [
          { role: "enemy" as const, room_id: plan.enemies, count: 3 },
          { role: "boss" as const, room_id: plan.boss, count: 1 },
          { role: "loot" as const, room_id: plan.loot, count: 1 },
        ],
    exits:
      d.environment === "outdoor"
        ? [{ side: "north" as const, label: "North Road" }, { side: "east" as const, label: "East Road" }]
        : d.environment === "indoor"
          ? [{ side: "south" as const, label: "Front Door" }]
          : [{ side: "north" as const, label: "Stairs Up" }],
  };
}

/** Ready-made briefs, one per setting preset, used when a campaign starts before the DM has generated any map. */
export const STARTER_BRIEFS = Object.fromEntries(SETTING_PRESETS.map((p) => [p, starterBrief(p)])) as Record<SettingPreset, MapBrief>;
