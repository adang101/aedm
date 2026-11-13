import { MapBriefSchema } from "@aedm/schemas";
import type { GameMap, MapBrief } from "@aedm/schemas";
import { buildMap } from "./build";
import { SETTING_PRESET_DATA, fallbackPreset, inferPreset } from "./settings";
import { validateMap } from "./validate";

export interface GenerateOptions {
  seed: number;
  id: string;
  /** ISO timestamp for meta.generated_at. The engine has no clock, so the caller supplies it. */
  generatedAt?: string;
  /** Loot tier (1 to 5) the map's lock DCs are scaled to: pass the party's gear allowance (`lootTierForLevel`). Default 1. */
  tier?: number;
  /** Make the generator's door tiles real door objects. Default `interact.doors.generated.enabled` (off until the client can open doors). */
  doorObjects?: boolean;
}

export const DEFAULT_GENERATED_AT = "1970-01-01T00:00:00Z";

/** Keeps at most 3 rooms (chained so they stay connected), re-homes slots and points of interest, keeps at most 2 exits. */
export function simplifyBrief(brief: MapBrief, setting: MapBrief["setting"] = brief.setting): MapBrief {
  const keep = brief.rooms.slice(0, 3);
  const ids = new Set(keep.map((r) => r.id));
  const home = keep[0]!.id;
  const rehome = (id: string): string => (ids.has(id) ? id : home);
  const rooms = keep.map((r, i) => ({
    ...r,
    size: keep.length > 1 && r.size === "large" ? ("medium" as const) : r.size,
    connects_to: [...new Set([...r.connects_to.filter((c) => ids.has(c)), ...(i > 0 ? [keep[i - 1]!.id] : [])])].filter((c) => c !== r.id),
  }));
  return {
    ...brief,
    setting,
    rooms,
    points_of_interest: brief.points_of_interest.slice(0, 4).map((p) => ({ ...p, room_id: rehome(p.room_id) })),
    entity_slots: brief.entity_slots.slice(0, 4).map((s) => ({ ...s, room_id: rehome(s.room_id) })),
    exits: brief.exits.slice(0, 2),
  };
}

/** The last resort: one chamber, plain rooms and corridors, the preset's own materials. */
function minimalBrief(brief: MapBrief): MapBrief {
  const home = brief.rooms[0]!;
  return {
    ...brief,
    setting: { name: brief.setting.name, ...(brief.setting.preset ? { preset: brief.setting.preset } : {}), layout: "rooms_and_corridors", environment: brief.setting.environment, mood: brief.setting.mood },
    size_class: brief.size_class === "large" ? "medium" : brief.size_class,
    rooms: [{ id: home.id, type: "chamber", size: "medium", connects_to: [] }],
    points_of_interest: brief.points_of_interest.slice(0, 3).map((p) => ({ ...p, room_id: home.id })),
    entity_slots: brief.entity_slots.slice(0, 3).map((s) => ({ ...s, room_id: home.id })),
    exits: brief.exits.slice(0, 1),
  };
}

/**
 * Generates a validated map. Tries the brief with seed, seed+1 and seed+2, then falls back: the brief's rooms
 * simplified, then the preset's own layout with simplified rooms, then a single plain chamber. Throws only when
 * even that fails. `attempts` counts the tries made.
 */
export function generateMap(brief: MapBrief, opts: GenerateOptions): { map: GameMap; attempts: number } {
  const parsed = MapBriefSchema.parse(brief);
  const generatedAt = opts.generatedAt ?? DEFAULT_GENERATED_AT;
  const s = parsed.setting;
  const preset = s.preset ?? inferPreset(`${s.name} ${parsed.theme_tags.join(" ")}`) ?? fallbackPreset(s.layout, s.environment);
  const pd = SETTING_PRESET_DATA[preset];
  const stages: MapBrief[] = [
    parsed, parsed, parsed,
    simplifyBrief(parsed),
    simplifyBrief(parsed, { ...s, layout: pd.layout, environment: pd.environment }),
    minimalBrief(parsed),
  ];
  const failures: string[] = [];
  for (let attempt = 1; attempt <= stages.length; attempt++) {
    const seed = opts.seed + attempt - 1;
    try {
      const map = buildMap(stages[attempt - 1]!, seed, {
        id: opts.id, generatedAt,
        ...(opts.tier !== undefined ? { tier: opts.tier } : {}),
        ...(opts.doorObjects !== undefined ? { doorObjects: opts.doorObjects } : {}),
      });
      const v = validateMap(map);
      if (v.ok) return { map, attempts: attempt };
      failures.push(`attempt ${attempt} (seed ${seed}): ${v.errors.join("; ")}`);
    } catch (e) {
      failures.push(`attempt ${attempt} (seed ${seed}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`generateMap failed after ${stages.length} attempts: ${failures.join(" | ")}`);
}
