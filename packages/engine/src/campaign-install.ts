/**
 * Installing a plan location's content when its map is added: the cast NPCs, the encounter's creatures, and the key items.
 * Everything is bound in `GameState.campaign` (plan id to runtime id) so objectives can be judged from state alone.
 * Pure and deterministic (the state's own rng); enemy archetypes come from outside, built by the server's enemy builder.
 */
import type { Enemy, EnemyRole, Item, PlanEncounter, SpriteRecipe, StoryBible } from "@aedm/schemas";
import { createContainerM, partyLevelOf, stashPocketsM, stockMapM } from "./containers.ts";
import { INTERACT } from "./data.ts";
import { fromState } from "./rng.ts";
import { createNpcM, spawnEnemyM } from "./spawn.ts";
import { registerArchetype } from "./state.ts";
import { campaignOf, emptyCampaignBinding, newId, occupiedTiles, run, tileKey, type Entity, type GameState, type Mut, type Result } from "./state.ts";
import { findFreeTileNear, getObjects, getSpawn } from "./map/index.ts";

/** One creature group the enemy builder must make for a location. */
export interface EnemyRequest {
  encounterId: string;
  /** Index into the encounter's `groups`. */
  group: number;
  concept: string;
  role: EnemyRole;
  count: number;
}

/** What the server must build archetypes for before installing a location: one per group of every encounter there, in order. */
export function locationEnemyRequests(bible: StoryBible, locationId: string): EnemyRequest[] {
  return (bible.encounters ?? [])
    .filter((e) => e.location === locationId)
    .flatMap((e) => e.groups.map((g, i) => ({ encounterId: e.id, group: i, concept: g.concept, role: g.role, count: g.count })));
}

export interface InstallInput {
  /**
   * Archetypes by encounter id, one per group in the group's order (see `locationEnemyRequests`). Each is stored with
   * `registerArchetype`, unless it carries the id of one already registered, which is reused. An encounter without them
   * is skipped and can be installed by a later call.
   */
  archetypes?: Record<string, readonly Enemy[]>;
  /** Approved sprites by lowercase NPC name, as in `DmContext.sprites`. */
  sprites?: Record<string, SpriteRecipe>;
}

export interface InstallSummary {
  ok: boolean;
  error?: string;
  locationId: string;
  mapId: string;
  /** What this call installed (nothing that was already bound). */
  cast: { id: string; entityId: string }[];
  encounters: { id: string; entityIds: string[] }[];
  items: { id: string; itemId: string; containerId: string }[];
  /** Plan content left for a later call, with the reason. */
  skipped: { kind: "cast" | "encounter" | "item"; id: string; reason: string }[];
}

const ROLE_RANK: EnemyRole[] = ["minion", "standard", "elite", "boss"];

/**
 * Install a location's content once its map is in the state (`addMap` first, so the chests and loot slots are stocked).
 * Binds the location to the map, places each cast NPC near the map's npc slot, spawns each encounter's creatures near its
 * enemy or boss slot (never on the party's start), and places each key item: in the holder's pockets (an NPC's, or the
 * toughest creature of the holder encounter, so it drops on defeat) or in the location's loot pile. Idempotent: what is
 * already bound is left alone, and content whose inputs are missing (archetypes, a holder) is skipped until a later call.
 * Never throws; a refusal comes back as `ok: false` with the state unchanged.
 */
export function installLocationContent(state: GameState, locationId: string, mapId: string, input: InstallInput = {}): Result<InstallSummary> {
  const summary: InstallSummary = { ok: false, locationId, mapId, cast: [], encounters: [], items: [], skipped: [] };
  const fail = (error: string): Result<InstallSummary> => ({ state, events: [], value: { ...summary, error } });
  const bible = state.bible;
  const loc = bible.locations?.find((l) => l.id === locationId);
  if (!loc) return fail(`unknown location ${locationId}`);
  if (!state.maps[mapId]) return fail(`unknown map ${mapId}`);
  const built = campaignOf(state).locations[locationId];
  if (built !== undefined && built !== mapId) return fail(`location ${locationId} is already built as map ${built}`);
  summary.ok = true;

  // archetypes first: registering is a state-to-state call
  let s0 = state;
  const archIds: Record<string, string[]> = {};
  const todo: PlanEncounter[] = (bible.encounters ?? []).filter((e) => e.location === locationId && !campaignOf(state).encounters[e.id]);
  for (const e of todo) {
    const list = input.archetypes?.[e.id] ?? [];
    if (list.length !== e.groups.length) {
      summary.skipped.push({ kind: "encounter", id: e.id, reason: `needs ${e.groups.length} archetypes (one per group), got ${list.length}` });
      continue;
    }
    const wrong = e.groups.findIndex((g, i) => list[i]!.role !== g.role);
    if (wrong >= 0) {
      summary.skipped.push({ kind: "encounter", id: e.id, reason: `group ${wrong} is a ${e.groups[wrong]!.role} but its archetype is a ${list[wrong]!.role}` });
      continue;
    }
    const ids: string[] = [];
    for (const a of list) {
      if (a.id && s0.archetypes[a.id]) { ids.push(a.id); continue; }
      const reg = registerArchetype(s0, a);
      if (!reg.ok) { summary.skipped.push({ kind: "encounter", id: e.id, reason: reg.errors.join("; ") }); ids.length = 0; break; }
      s0 = reg.state;
      ids.push(reg.archetype.id as string);
    }
    if (ids.length === list.length) archIds[e.id] = ids;
  }

  return run(s0, fromState(s0.rngState), (m: Mut) => {
    const s = m.s;
    const map = s.maps[mapId]!;
    const b = (s.campaign ??= emptyCampaignBinding());
    b.locations[locationId] = mapId;
    stockMapM(m, mapId);

    const objects = getObjects(map);
    const slots = (...roles: string[]) => objects.filter((o) => o.type === "entity_slot" && roles.includes(o.role));
    const start = getSpawn(map, "party_start") ?? objects.find((o) => o.type === "spawn") ?? { x: Math.floor(map.width / 2), y: Math.floor(map.height / 2) };
    const occupied = occupiedTiles(s, mapId);
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) occupied.add(tileKey(start.x + dx, start.y + dy));
    const place = (anchors: { x: number; y: number }[], n: number): { x: number; y: number } | null => {
      const a = anchors.length > 0 ? anchors[n % anchors.length]! : start;
      const spot = findFreeTileNear(map, a.x, a.y, occupied);
      if (spot) occupied.add(tileKey(spot.x, spot.y));
      return spot;
    };

    // cast
    const level = partyLevelOf(s);
    let n = 0;
    for (const c of (bible.cast ?? []).filter((x) => x.location === locationId && !b.cast[x.id])) {
      const spot = place(slots("npc"), n++);
      if (!spot) { summary.skipped.push({ kind: "cast", id: c.id, reason: "no free tile on the map" }); continue; }
      const r = createNpcM(m, { map_id: mapId, x: spot.x, y: spot.y, name: c.name, concept: c.concept, role: c.role, sprite_tags: [], voice: c.voice }, { partyLevel: level, sprites: input.sprites });
      if (!r.ok) { occupied.delete(tileKey(spot.x, spot.y)); summary.skipped.push({ kind: "cast", id: c.id, reason: r.reason }); continue; }
      b.cast[c.id] = r.id;
      summary.cast.push({ id: c.id, entityId: r.id });
    }

    // encounters
    for (const e of todo) {
      const ids = archIds[e.id];
      if (!ids) continue;
      const entityIds: string[] = [];
      let k = 0;
      e.groups.forEach((g, gi) => {
        const arch = s.archetypes[ids[gi] as string] as Enemy;
        const anchors = g.role === "boss" ? slots("boss", "enemy") : slots("enemy", "boss");
        for (let i = 0; i < g.count; i++) {
          const spot = place(anchors, k++);
          if (!spot) break;
          entityIds.push(spawnEnemyM(m, arch, mapId, spot.x, spot.y, g.count > 1).id);
        }
      });
      if (entityIds.length === 0) summary.skipped.push({ kind: "encounter", id: e.id, reason: "no free tile on the map" });
      b.encounters[e.id] = { mapId, entityIds };
      summary.encounters.push({ id: e.id, entityIds });
    }

    // key items
    for (const k of (bible.key_items ?? []).filter((x) => x.location === locationId && !b.items[x.id])) {
      const item: Item = { id: "", name: k.name, kind: "quest", value: 0 };
      let holder: Entity | undefined;
      if (k.held_by?.kind === "cast") holder = s.entities[b.cast[k.held_by.id] ?? ""];
      else if (k.held_by) {
        const foes = (b.encounters[k.held_by.id]?.entityIds ?? []).map((id) => s.entities[id]).filter((x): x is Entity => !!x);
        holder = foes.reduce<Entity | undefined>((best, x) => {
          const rank = (y: Entity) => ROLE_RANK.indexOf(s.archetypes[y.refId]?.role ?? "minion");
          return !best || rank(x) > rank(best) ? x : best;
        }, undefined);
      }
      if (k.held_by && !holder) {
        summary.skipped.push({ kind: "item", id: k.id, reason: `its holder ${k.held_by.id} has not been placed` });
        continue;
      }
      item.id = newId(s, "it");
      let containerId: string;
      if (holder) {
        containerId = stashPocketsM(m, holder, [item]).id;
      } else {
        const piles = Object.values(s.containers).filter((c) => c.map_id === mapId && c.kind !== "pockets" && c.items.length < INTERACT.pileCap);
        const home = piles.find((c) => c.kind === "pile" && c.object_id) ?? piles.find((c) => c.kind === "chest");
        const cache = home ? undefined : (place([], 0) ?? start);
        const target = home ?? createContainerM(m, { kind: "pile", mapId, x: cache!.x, y: cache!.y, label: "Hidden cache" });
        target.items.push(item);
        containerId = target.id;
      }
      b.items[k.id] = item.id;
      summary.items.push({ id: k.id, itemId: item.id, containerId });
    }
    return summary;
  });
}
