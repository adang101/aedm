/**
 * Building a plan location for the running game: a map from the plan's brief, enemy archetypes for its encounters and
 * looks for its cast. Preparing makes the model calls and reads no mutable state, so it can run in the background; applying
 * is synchronous and runs inside the session's queue. The engine owns the numbers: archetypes are clamped to the party's
 * level and sized so each planned fight fits the encounter budget.
 */
import {
  addMap, bossThreatCap, clampEnemy, createRng, enemyRangesForLevel, enemyThreat, encounterBudget, generateMap, installLocationContent, locationEnemyRequests,
  locationMapBrief, partyLevelOf,
  type EngineEvent, type GameState, type InstallSummary,
} from "@aedm/engine";
import type { Enemy, GameMap, SpriteRecipe, StoryBible } from "@aedm/schemas";

/** An enemy as the builder returned it, before it is fitted to the party. */
export interface BuiltGroup { enemy: Enemy; count: number }

/** What preparing a location produces; nothing in it depends on the live state except the plan. */
export interface PreparedLocation {
  locationId: string;
  map: GameMap;
  /** Built creatures by encounter id, one per group in the group's order. */
  groups: Record<string, BuiltGroup[]>;
  /** Cast looks by lowercase NPC name. */
  sprites: Record<string, SpriteRecipe>;
}

export function planIndex(bible: StoryBible, locationId: string): number {
  return (bible.locations ?? []).findIndex((l) => l.id === locationId);
}

/** The id of the map built for a plan location: the first one is `m_start`. */
export function locationMapId(bible: StoryBible, locationId: string): string {
  const i = planIndex(bible, locationId);
  return i <= 0 ? "m_start" : `m_loc_${i}`;
}

/** Deterministic map for a plan location (a seed derived from the game seed and the location, so no live rng is touched). */
export function buildLocationMap(state: Pick<GameState, "seed" | "bible">, locationId: string, generatedAt: string): GameMap | undefined {
  const brief = locationMapBrief(state.bible, locationId);
  if (!brief) return undefined;
  const seed = createRng(Math.imul(state.seed | 0, 31) ^ Math.imul(planIndex(state.bible, locationId) + 1, 2654435761)).int(1, 0x7ffffffe);
  return generateMap(brief, { seed, id: locationMapId(state.bible, locationId), generatedAt }).map;
}

export interface Fit { enemies: Enemy[]; level: number; threat: number; budget: number }

/**
 * Scale each group of one encounter to the party: clamp every creature into the ranges for the party level, and when the
 * whole fight (every group times its count) is over the standard encounter budget, clamp to lower levels (and, at each level, to
 * the weakest stats the ranges allow) until it fits. Never goes below level 1 (a solo level-1 party may still get a fight over budget; the DM's `start_combat` raises the
 * difficulty to match). A creature whose role the clamp changed keeps the planned role, so the plan can still install it.
 */
export function fitEncounter(groups: readonly BuiltGroup[], partyLevel: number, partySize: number, plannedRoles: readonly Enemy["role"][]): Fit {
  const size = Math.max(1, partySize);
  const level = Math.max(1, partyLevel);
  const keepRole = (e: Enemy, i: number): Enemy => (e.role === plannedRoles[i] ? e : { ...e, role: plannedRoles[i] as Enemy["role"] });
  const attempt = (l: number, weakest: boolean): Fit => {
    const enemies = groups.map((g, i) => {
      if (!weakest) return keepRole(clampEnemy(g.enemy, l).enemy, i);
      const rg = enemyRangesForLevel(l, g.enemy.role);
      const stats = { ...g.enemy.stats, hp: rg.hp.min, defense: rg.defense.min, attack_bonus: rg.attack.min, damage_dice: "1d4" };
      return keepRole(clampEnemy({ ...g.enemy, stats }, l).enemy, i);
    });
    const threat = enemies.reduce((sum, e, i) => sum + (e.threat ?? enemyThreat(e)) * (groups[i] as BuiltGroup).count, 0);
    const budget = encounterBudget(size, level, "standard", { boss: enemies.some((e) => e.role === "boss") });
    return { enemies, level: l, threat, budget };
  };
  const fits = (f: Fit): boolean =>
    f.threat <= f.budget + 1e-9 && f.enemies.every((e) => e.role !== "boss" || (e.threat ?? enemyThreat(e)) <= bossThreatCap(size, level) + 1e-9);
  let last = attempt(level, false);
  for (let l = level; l >= 1 && !fits(last); l--) {
    last = attempt(l, false);
    if (!fits(last)) last = attempt(l, true);
  }
  return last;
}

export interface AppliedLocation {
  state: GameState;
  events: EngineEvent[];
  summary: InstallSummary;
  /** Encounters whose creatures could not be sized under the budget even at level 1. */
  overBudget: string[];
}

/** Add the prepared map and install the plan's content, with creatures fitted to the party as it is now. */
export function applyPrepared(state: GameState, prep: PreparedLocation): AppliedLocation | { error: string } {
  const level = partyLevelOf(state);
  const size = Object.keys(state.characters).length;
  const archetypes: Record<string, Enemy[]> = {};
  const overBudget: string[] = [];
  const reqs = locationEnemyRequests(state.bible, prep.locationId);
  for (const [encounterId, groups] of Object.entries(prep.groups)) {
    const roles = reqs.filter((r) => r.encounterId === encounterId).map((r) => r.role);
    if (roles.length !== groups.length) continue;
    const fit = fitEncounter(groups, level, size, roles);
    if (fit.threat > fit.budget + 1e-9) overBudget.push(encounterId);
    archetypes[encounterId] = fit.enemies;
  }
  const added = addMap(state, prep.map);
  const installed = installLocationContent(added.state, prep.locationId, prep.map.id, { archetypes, sprites: prep.sprites });
  const summary = installed.value as InstallSummary;
  if (!summary.ok) return { error: summary.error ?? "install failed" };
  return { state: installed.state, events: [...added.events, ...installed.events], summary, overBudget };
}
