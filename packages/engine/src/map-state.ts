/** Putting maps into the game state, and bringing loaded states up to date. */
import type { GameMap } from "@aedm/schemas";
import { stockMapM } from "./containers.ts";
import type { EngineEvent } from "./events.ts";
import { fromState } from "./rng.ts";
import { cloneState, finish, normalizeState, type GameState, type Mut, type Result } from "./state.ts";

/**
 * Add a map, make it current if there is none, and stock its chests and loot slots as containers (contents come from
 * the map's own seed and the party level; see `stockMapM`).
 */
export function addMap(state: GameState, map: GameMap): Result {
  const s = cloneState(state);
  s.maps = { ...s.maps, [map.id]: map };
  if (s.currentMapId === null) s.currentMapId = map.id;
  const ev: EngineEvent[] = [{ type: "map_added", mapId: map.id }];
  const m: Mut = { s, rng: fromState(s.rngState), ev };
  stockMapM(m, map.id);
  return finish(m, undefined);
}

/**
 * Bring a state read from a save up to date: default the fields older saves lack, then stock every map's containers
 * (a map already stocked is left alone). Idempotent; call it when loading a save.
 */
export function restoreState(raw: Parameters<typeof normalizeState>[0]): GameState {
  const s = cloneState(normalizeState(raw) as GameState);
  const m: Mut = { s, rng: fromState(s.rngState), ev: [] };
  for (const mapId of Object.keys(s.maps ?? {})) stockMapM(m, mapId);
  return s;
}
