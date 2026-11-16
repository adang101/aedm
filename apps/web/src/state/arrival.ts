import type { GameMap } from "@aedm/schemas";

/** The place a map stands for, as the story names it. */
export function placeName(map: Pick<GameMap, "meta">): string {
  // tolerant of a stub map in tests and of an older server
  const name = (map.meta as GameMap["meta"] | undefined)?.setting?.name;
  return name?.trim() || "An unnamed place";
}

/** The system line the log shows when the party reaches a new map. */
export function arrivalLine(map: Pick<GameMap, "meta">): string {
  return `The party arrives at ${placeName(map)}.`;
}

/**
 * The engine's own line for a scene change names the map by id ("The party arrives at m_gen_3 (party_start)"), which says
 * nothing to a player. The client writes the named line instead, so this one is dropped.
 */
export function isRawArrivalLine(text: string): boolean {
  return /^The party arrives at \S+ \([^()]*\)\.?$/i.test(text.trim());
}
