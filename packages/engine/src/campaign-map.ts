/**
 * From a plan location to a map the existing generator accepts: the location's own setting, one exit per connection,
 * and entity slots for the cast, encounters and key items the plan puts there. Pure.
 */
import type { ExitSide, MapBrief, PlanLocation, StoryBible } from "@aedm/schemas";
import { campaignNeighbors } from "./campaign.ts";
import { CAMPAIGN } from "./data.ts";
import { LAYOUT_PLANS, SETTING_PRESET_DATA, fallbackPreset, inferPreset } from "./map/index.ts";
import { campaignOf, type GameState } from "./state.ts";

/** The first location: where the party starts. */
export function startLocation(bible: StoryBible): PlanLocation | undefined {
  return bible.locations?.[0];
}

export interface LocationExit {
  side: ExitSide;
  /** The exit's name on the map (at most 32 characters, unique on the map). */
  label: string;
  /** Plan location id the exit leads to. */
  to: string;
}

const EXIT_NAME_MAX = 32;

/**
 * The exits a location's map has: one per connected location (connections count both ways), in list order. A connection
 * to a later location leaves by the east side first, one to an earlier location by the west side first, then the rest.
 * Sides and labels are unique. Empty for an unknown id.
 */
export function locationExits(bible: StoryBible, locationId: string): LocationExit[] {
  const locs = bible.locations ?? [];
  const here = locs.findIndex((l) => l.id === locationId);
  if (here < 0) return [];
  const used = new Set<string>();
  const labels = new Set<string>();
  const out: LocationExit[] = [];
  for (const to of campaignNeighbors(bible, locationId)) {
    const idx = locs.findIndex((l) => l.id === to);
    const order = idx > here ? CAMPAIGN.map.forwardSides : CAMPAIGN.map.backSides;
    const side = (order.find((s) => !used.has(s)) ?? CAMPAIGN.map.forwardSides.find((s) => !used.has(s))) as ExitSide | undefined;
    if (!side) break;
    used.add(side);
    let label = `To ${locs[idx]!.name}`.slice(0, EXIT_NAME_MAX).trim();
    for (let n = 2; labels.has(label.toLowerCase()); n++) label = `${label.slice(0, EXIT_NAME_MAX - String(n).length).trim()}${n}`;
    labels.add(label.toLowerCase());
    out.push({ side, label, to });
  }
  return out;
}

type BriefEntitySlot = MapBrief["entity_slots"][number];

const cap = (n: number) => Math.min(n, CAMPAIGN.map.maxSlotCount);

/**
 * The map brief for a plan location, ready for `generateMap`. Undefined for an unknown id. The setting, theme tags and
 * size come from the location; rooms and where things go come from the layout's room plan; features become points of
 * interest (the preset's own starter ones when there are none); each connection becomes an exit (see `locationExits`).
 * Slots: one `npc` slot for the cast, an `enemy` slot for the encounter creatures that are not bosses, a `boss` slot for a
 * boss and a `loot` slot when a key item lies here with no holder.
 */
export function locationMapBrief(bible: StoryBible, locationId: string): MapBrief | undefined {
  const loc = bible.locations?.find((l) => l.id === locationId);
  if (!loc) return undefined;
  const plan = LAYOUT_PLANS[loc.setting.layout];
  const preset = loc.setting.preset ?? inferPreset(`${loc.setting.name} ${(loc.theme_tags ?? []).join(" ")}`) ?? fallbackPreset(loc.setting.layout, loc.setting.environment);
  const kinds = loc.features?.length ? loc.features : SETTING_PRESET_DATA[preset].starter.pois;

  const castHere = (bible.cast ?? []).filter((c) => c.location === locationId).length;
  const groups = (bible.encounters ?? []).filter((e) => e.location === locationId).flatMap((e) => e.groups);
  const soldiers = groups.filter((g) => g.role !== "boss").reduce((n, g) => n + g.count, 0);
  const bosses = groups.filter((g) => g.role === "boss").reduce((n, g) => n + g.count, 0);
  const looseItems = (bible.key_items ?? []).filter((k) => k.location === locationId && !k.held_by).length;
  const slots: BriefEntitySlot[] = [];
  if (castHere > 0) slots.push({ role: "npc", room_id: plan.npc, count: cap(castHere) });
  if (soldiers > 0) slots.push({ role: "enemy", room_id: plan.enemies, count: cap(soldiers) });
  if (bosses > 0) slots.push({ role: "boss", room_id: plan.boss, count: 1 });
  if (looseItems > 0) slots.push({ role: "loot", room_id: plan.loot, count: 1 });

  const exits = locationExits(bible, locationId).map(({ side, label }) => ({ side, label }));
  return {
    setting: structuredClone(loc.setting),
    theme_tags: [...(loc.theme_tags ?? [])],
    size_class: loc.size_class ?? CAMPAIGN.map.defaultSizeClass,
    rooms: plan.rooms.map(([id, type, size, connects_to]) => ({ id, type, size, connects_to: [...connects_to] })),
    points_of_interest: kinds.slice(0, 8).map((kind, i) => ({ kind: kind.slice(0, 24), room_id: plan.poi[i % plan.poi.length] as string })),
    entity_slots: slots,
    exits: exits.length > 0 ? exits : [{ side: "east", label: "Onward" }],
  };
}

/**
 * Where an exit of a campaign map leads: the plan location and, when its map has been built, the map id. Undefined when the
 * map is not a campaign map or has no exit of that name (matched case-insensitively). The server uses it to generate or
 * enter the destination when a party takes a pending exit.
 */
export function resolveExit(state: GameState, mapId: string, exitName: string): { locationId: string; mapId?: string } | undefined {
  const b = campaignOf(state);
  const here = Object.keys(b.locations).find((k) => b.locations[k] === mapId);
  if (!here) return undefined;
  const want = exitName.trim().toLowerCase();
  const hit = locationExits(state.bible, here).find((e) => e.label.toLowerCase() === want);
  if (!hit) return undefined;
  const built = b.locations[hit.to];
  return { locationId: hit.to, ...(built ? { mapId: built } : {}) };
}
