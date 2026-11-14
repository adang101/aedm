import { hazardTiles, pathAvoiding } from "./ai-nav.ts";
import { act, type ActionResult } from "./combat.ts";
import { RULES } from "./data.ts";
import { canMove, hasCondition, isStanding, walkPath } from "./mutate.ts";
import type { Rng } from "./rng.ts";
import { currentMap, emit, occupiedTiles, placePartyInternal, rngFromState, run, sideOf, sightBlockers, tileKey, type Entity, type GameState, type Mut, type Result } from "./state.ts";
import { findFreeTileNear, getSpawn, hasLineOfSight, isWalkable, type Point } from "./map/index.ts";

// Out-of-combat behavior for hostile and allied creatures. Pure: nothing here reads a clock or rolls dice.

const dist = (a: Point, b: Point) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** Party characters on the map who are up (not downed or out). */
const standingParty = (s: GameState, mapId: string): Entity[] =>
  Object.values(s.entities).filter((e) => e.kind === "pc" && e.mapId === mapId && isStanding(e));

/** Living allied NPCs (role `ally`, still on the party's side) on a map. */
function alliedNpcs(s: GameState, mapId: string): Entity[] {
  return Object.values(s.entities)
    .filter((e) => {
      if (e.kind !== "npc" || e.mapId !== mapId || !isStanding(e) || sideOf(e) !== "party") return false;
      const rec = s.npcs[e.refId];
      return !!rec && rec.role === "ally" && rec.alive !== false;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

// ---------- aggro ----------

export interface Aggro {
  /** The hostile creatures that noticed the party, by id. */
  enemyIds: string[];
  /** Everyone to put in the fight: the standing party characters on the map, allied NPCs (when `rules.ai.aggro.includeAllies`), the creatures that noticed and the hostiles near them. */
  participants: string[];
}

/**
 * Whether a fight should start by itself. True when no combat is active and a living hostile enemy on the current
 * map has a standing party character within `rules.ai.aggro.radius` tiles in line of sight (walls, smoke and closed
 * doors block it). Hostile enemies within `joinRadius` of one that noticed join (all of them when `joinAll`).
 * Creatures that surrendered are NPCs and never aggro; neither do calm ones (`Entity.calm`, set on the survivors when a
 * fight ends and cleared when a new fight starts with them), as noticers or as joiners. Returns null when nothing happens. Start the fight with
 * `startCombat(state, rng, participants, difficulty)`.
 */
export function aggroCheck(state: GameState): Aggro | null {
  const cfg = RULES.ai.aggro;
  if (!cfg.enabled || state.combat || !state.currentMapId) return null;
  const mapId = state.currentMapId;
  const map = currentMap(state);
  if (!map) return null;
  const party = standingParty(state, mapId);
  if (party.length === 0) return null;
  const hostiles = Object.values(state.entities)
    .filter((e) => e.kind === "enemy" && e.mapId === mapId && isStanding(e) && !e.calm)
    .sort((a, b) => a.id.localeCompare(b.id));
  const blockers = sightBlockers(state, mapId);
  const noticed = hostiles.filter((h) => party.some((p) => dist(h, p) <= cfg.radius && hasLineOfSight(map, h, p, blockers)));
  if (noticed.length === 0) return null;
  const joined = hostiles.filter((h) => cfg.joinAll || noticed.some((n) => n.id === h.id || dist(h, n) <= cfg.joinRadius));
  const allies = cfg.includeAllies ? alliedNpcs(state, mapId) : [];
  return {
    enemyIds: noticed.map((e) => e.id),
    participants: [...party, ...allies, ...joined].map((e) => e.id),
  };
}

// ---------- allies follow ----------

/**
 * Out of combat, each living allied NPC on the current map that is more than `rules.ai.follow.maxDistance` tiles
 * from the nearest standing party character walks up to `stepTiles` along a path toward that character, stopping
 * within `stopDistance`. It avoids occupied tiles, closed doors and (when a short detour exists) damaging terrain.
 * Does nothing (ok, no events) when nobody needs to move; refused during combat.
 */
export function followStep(state: GameState, rng: Rng): ActionResult {
  return act(state, rng, "follow", (m) => {
    const cfg = RULES.ai.follow;
    const s = m.s;
    if (s.combat) return "cannot follow during combat";
    if (!cfg.enabled || !s.currentMapId) return undefined;
    const map = s.maps[s.currentMapId];
    if (!map) return undefined;
    const party = standingParty(s, s.currentMapId);
    if (party.length === 0) return undefined;
    for (const ally of alliedNpcs(s, s.currentMapId)) {
      if (!canMove(ally) || hasCondition(ally, "rooted")) continue;
      const nearest = party.reduce((best, p) => (dist(ally, p) < dist(ally, best) ? p : best));
      if (dist(ally, nearest) <= cfg.maxDistance) continue;
      const occupied = occupiedTiles(s, ally.mapId, { exceptId: ally.id });
      const hazards = hazardTiles(s, ally);
      let path: Point[] | null = null;
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          if (ox === 0 && oy === 0) continue;
          const goal = { x: nearest.x + ox, y: nearest.y + oy };
          if (occupied.has(tileKey(goal.x, goal.y)) || hazards.has(tileKey(goal.x, goal.y)) || !isWalkable(map, goal.x, goal.y)) continue;
          const p = pathAvoiding(map, ally, goal, occupied, hazards);
          if (p && p.length > 0 && (path === null || p.length < path.length)) path = p;
        }
      }
      if (!path) continue;
      let k = Math.min(path.length, cfg.stepTiles);
      const stop = path.findIndex((p) => dist(p, nearest) <= cfg.stopDistance);
      if (stop >= 0) k = Math.min(k, stop + 1);
      while (k > 0 && hazards.has(tileKey((path[k - 1] as Point).x, (path[k - 1] as Point).y))) k--;
      if (k <= 0) continue;
      walkPath(m, ally, path, k);
      const rec = s.npcs[ally.refId];
      if (rec) { rec.x = ally.x; rec.y = ally.y; }
    }
    return undefined;
  });
}

// ---------- allies at a scene change ----------

/**
 * Ids of the allied NPCs who travel with the party to a new map: those on the party's current map within
 * `rules.ai.follow.maxDistance` tiles of a present, standing character. Call it before the party is moved.
 */
export function alliesWithParty(state: GameState, presentCharacterIds?: string[]): string[] {
  if (!RULES.ai.follow.enabled || !state.currentMapId) return [];
  const present = new Set(presentCharacterIds ?? Object.keys(state.characters));
  const party = standingParty(state, state.currentMapId).filter((p) => present.has(p.id));
  if (party.length === 0) return [];
  return alliedNpcs(state, state.currentMapId)
    .filter((a) => party.some((p) => dist(a, p) <= RULES.ai.follow.maxDistance))
    .map((a) => a.id);
}

/**
 * Place the given allied NPCs next to a spawn on `mapId` (the same way the party is placed) and update their NPC
 * records and `located_at` facts. Call it after the party has been placed so the allies take the free tiles around
 * the characters. Returns how many were moved.
 */
export function moveAlliesToScene(m: Mut, allyIds: string[], mapId: string, spawnName: string): number {
  const s = m.s;
  const map = s.maps[mapId];
  const spawn = map ? getSpawn(map, spawnName) : null;
  if (!map || !spawn) return 0;
  const occupied = occupiedTiles(s, mapId);
  let moved = 0;
  for (const id of allyIds) {
    const e = s.entities[id];
    if (!e || e.kind !== "npc") continue;
    const spot = findFreeTileNear(map, spawn.x, spawn.y, occupied);
    if (!spot) continue;
    occupied.add(tileKey(spot.x, spot.y));
    const from = { x: e.x, y: e.y };
    e.mapId = mapId; e.x = spot.x; e.y = spot.y;
    const rec = s.npcs[e.refId];
    if (rec) { rec.map_id = mapId; rec.x = spot.x; rec.y = spot.y; }
    const name = e.name.trim().toLowerCase();
    if (s.facts.some((f) => f.subject.trim().toLowerCase() === name && f.predicate === "located_at")) {
      s.facts = s.facts.filter((f) => !(f.subject.trim().toLowerCase() === name && f.predicate === "located_at"));
      s.facts.push({ subject: e.name, predicate: "located_at", object: mapId });
    }
    emit(m, { type: "moved", entityId: id, entityName: e.name, from, to: spot, tiles: 0, reason: "scene" });
    moved++;
  }
  return moved;
}

/**
 * Put the party's tokens on a spawn of `mapId` and make it the current map, like `placePartyOnMap`, and bring along the
 * allied NPCs that were within follow distance of the party (`alliesWithParty`, picked before the move). Returns false,
 * and changes nothing, when the map or spawn does not exist.
 */
export function placePartyWithAllies(state: GameState, mapId: string, spawnName = "party_start", characterIds?: string[]): Result<boolean> {
  return run(state, rngFromState(state), (m) => {
    const allies = alliesWithParty(m.s, characterIds);
    if (!placePartyInternal(m, mapId, spawnName, characterIds)) return false;
    moveAlliesToScene(m, allies, mapId, spawnName);
    m.s.currentMapId = mapId;
    return true;
  });
}
