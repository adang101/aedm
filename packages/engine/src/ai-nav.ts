import type { GameMap } from "@aedm/schemas";
import { RULES } from "./data.ts";
import { sideOf, tileKey, type Entity, type GameState } from "./state.ts";
import { findPath, type Point } from "./map/index.ts";
import { knownTrapTiles } from "./traps.ts";

/**
 * Tiles that hurt a creature standing on them and that it knows about: fire with damage dice, visible
 * traps of the other side (a creature's own side's traps spare it, and hidden traps are not known), and the revealed, armed map
 * traps (`knownTrapTiles`; enemies never spring them but keep clear of them too, as allies do).
 * Empty when `rules.ai.hazard.avoid` is off.
 */
export function hazardTiles(s: GameState, e: Pick<Entity, "mapId" | "kind" | "disposition">): Set<string> {
  const set = new Set<string>();
  if (!RULES.ai.hazard.avoid) return set;
  for (const t of s.terrain) {
    if (t.mapId !== e.mapId || !t.dice) continue;
    if (t.kind === "fire" || (t.kind === "trap" && !t.hidden && t.side !== sideOf(e))) set.add(tileKey(t.x, t.y));
  }
  for (const k of knownTrapTiles(s, e.mapId)) set.add(k);
  return set;
}

/**
 * Shortest path, preferring one that skips `hazards` when it is at most `rules.ai.hazard.detourAllowance` tiles
 * longer. Falls back to the plain shortest path (which may cross hazards), or null when there is none.
 */
export function pathAvoiding(map: GameMap, from: Point, to: Point, occupied: Set<string>, hazards: Set<string>): Point[] | null {
  const plain = findPath(map, from, to, occupied);
  if (!plain || hazards.size === 0 || !plain.some((p) => hazards.has(tileKey(p.x, p.y)))) return plain;
  const alt = findPath(map, from, to, new Set([...occupied, ...hazards]));
  return alt && alt.length <= plain.length + RULES.ai.hazard.detourAllowance ? alt : plain;
}
