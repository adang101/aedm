/**
 * Where a piece of the campaign plan is right now, as a landmark name ("the ferry dock"), so hints can say
 * "Talk to Old Tam at the ferry dock". Reads the state's own binding and positions; pure.
 */
import { landmarkAt } from "./map/index.ts";
import { campaignOf, type GameState } from "./state.ts";

export type PlanThing = "cast" | "encounter" | "item";

export type PlaceState = Pick<GameState, "maps"> & Partial<Pick<GameState, "entities" | "containers" | "campaign">>;

/** "the" plus the landmark's name in lower case. */
export const landmarkPhrase = (name: string): string => `the ${name.charAt(0).toLowerCase()}${name.slice(1)}`;

/**
 * The landmark a cast member stands at, an encounter's creatures are gathered at, or a key item rests at, as "the ferry dock".
 * Undefined when the thing is not placed yet, not on a map with landmarks, or not near any.
 */
export function planThingLandmark(state: PlaceState, kind: PlanThing, id: string): string | undefined {
  const entities = state.entities ?? {};
  const b = campaignOf(state as GameState);
  let spot: { mapId: string; x: number; y: number } | undefined;
  if (kind === "cast") {
    spot = entities[b.cast[id] ?? ""];
  } else if (kind === "encounter") {
    const e = (b.encounters[id]?.entityIds ?? []).map((x) => entities[x]).find((x) => x !== undefined);
    spot = e;
  } else {
    const itemId = b.items[id];
    const c = itemId ? Object.values(state.containers ?? {}).find((x) => x.items.some((i) => i.id === itemId)) : undefined;
    const holder = c?.owner_entity_id ? entities[c.owner_entity_id] : undefined;
    spot = holder ?? (c ? { mapId: c.map_id, x: c.x, y: c.y } : undefined);
  }
  const map = spot ? state.maps[spot.mapId] : undefined;
  const l = map && spot ? landmarkAt(map, spot.x, spot.y, 1) : undefined;
  return l ? landmarkPhrase(l.name) : undefined;
}
