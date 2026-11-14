import {
  CharacterCreateSchema, CharacterSchema,
  type Ability, type AbilityDraft, type AbilityScoreKey, type Character, type CharacterCreate, type CharacterView,
  type CheckTag, type Condition, type Container, type ContainerSummary, type ContentRating, type Difficulty, type Disposition,
  type Enemy, type EntityView, type GameMap, type InteractableState, type Item, type Lock, type MapBrief, type MapObject,
  type NpcRecord, type Quest, type StoryThread, type SpriteRecipe, type StoryBible, type TerrainKind, type WorldFact, type DamageType,
} from "@aedm/schemas";
import type { EngineEvent } from "./events.ts";
import { INTERACT, RULES } from "./data.ts";
import { abilityCost, validateCharacterAbilities } from "./cost.ts";
import { createRng, fromState, type Rng } from "./rng.ts";
import { hpMax as computeHpMax, levelFromGrowth, levelCaps, validatePointBuy } from "./rules.ts";
import { enemyThreat, validateEnemy } from "./threat.ts";
import { findFreeTileNear, getObjects, getSpawn } from "./map/index.ts";
import { designSpriteOffline } from "./sprites.ts";

// ---------- types ----------

export type Side = "party" | "enemy";

export interface ConditionInstance { condition: Condition; turns: number; source?: string }
export interface CheckBonusInstance { bonus: number; tags: CheckTag[]; turns: number }

export interface Entity {
  id: string;
  kind: "pc" | "npc" | "enemy";
  name: string;
  mapId: string;
  x: number;
  y: number;
  hp: number;
  hpMax: number;
  conditions: ConditionInstance[];
  /** Remaining absorb value. Mirrors the `shielded` condition. */
  shield: number;
  sprite: SpriteRecipe;
  /** Character id (pc), archetype id (enemy) or npc id (npc). */
  refId: string;
  disposition?: Disposition;
  cooldowns: Record<string, number>;
  usesLeft: Record<string, number>;
  checkBonuses: CheckBonusInstance[];
  /** Own turns spent downed (pc only). Present only while downed. */
  downedRounds?: number;
  /** True once a downed pc has been out for 3 rounds. */
  out?: boolean;
  /** Enemy morale this fight: `held` once a check was passed, `broken` once it flees or surrenders. */
  morale?: "held" | "broken";
  /** Set once a boss or elite was reported as bloodied this fight. */
  bloodied?: true;
}

export interface TerrainTile {
  id: string;
  mapId: string;
  x: number;
  y: number;
  kind: TerrainKind;
  /** Rounds left; null for traps (until triggered). */
  turns: number | null;
  ownerId: string;
  side: Side;
  dice?: string;
  damageType?: DamageType;
  hidden?: boolean;
}

export interface TurnState { movementLeft: number; actionUsed: boolean; quickUsed: boolean }

/** Superset of the WebSocket CombatState (round, order, active_id). */
export interface CombatState {
  round: number;
  order: { entity_id: string; initiative: number }[];
  active_id: string;
  /** Index of `active_id` in `order` (-1 before the first turn). */
  cursor: number;
  difficulty: Difficulty;
  turn: TurnState;
  /** Set once enemies_cleared / party_downed were announced, so each fires once. */
  announced?: { cleared?: boolean; wiped?: boolean };
}

export interface SessionState {
  growthAwarded: Record<string, { points: number; count: number }>;
  lootValueThisEncounter: number;
}

/**
 * What has changed on a map interactable since the map was built. Maps are shared by reference and never mutated, so
 * door, lever and sign changes live here, keyed by `objectKey(mapId, objectId)`. Chest state lives in `containers`.
 */
export interface InteractableOverride {
  state?: InteractableState;
  /** `null`: the lock is gone (opened with a key, picked or broken). Absent: the map object's own lock stands. */
  lock?: Lock | null;
  text?: string;
}

export interface GameState {
  v: 1;
  seed: number;
  campaignId: string;
  rngState: number;
  /** Bumped whenever a call produced events; use for state_diff ordering. */
  seq: number;
  /** DM beat counter (see `advanceBeat`). */
  turn: number;
  /** Counter behind every generated id. */
  nextId: number;
  bible: StoryBible;
  facts: WorldFact[];
  /** The DM's open and closed story threads (see `open_thread`). */
  threads: StoryThread[];
  contentRating: ContentRating;
  maps: Record<string, GameMap>;
  currentMapId: string | null;
  characters: Record<string, Character>;
  archetypes: Record<string, Enemy>;
  entities: Record<string, Entity>;
  npcs: Record<string, NpcRecord>;
  combat: CombatState | null;
  terrain: TerrainTile[];
  absentEntityIds: string[];
  /** Level-ups waiting on a player choice (+1 score at levels 3, 6, 9; a new or upgraded ability). */
  pendingLevelUps: Record<string, { scorePoints: number; abilityPicks: number }>;
  spawnCounts: Record<string, number>;
  /** Chests, piles of dropped items, remains and NPC pockets, keyed by container id (`cn_` plus a number). Missing in older saves. */
  containers: Record<string, Container>;
  /** Door, lever and sign changes by `objectKey`. Missing in older saves. */
  interactables: Record<string, InteractableOverride>;
  session: SessionState;
  log: EngineEvent[];
}

/**
 * Fills in what saves from before containers lack (`containers`, `interactables`), so an old save loads unchanged.
 * Idempotent. Use `restoreState` (map-state.ts) to also stock the chests of the maps it holds.
 */
export function normalizeState<T extends Omit<GameState, "containers" | "interactables"> & Partial<Pick<GameState, "containers" | "interactables">>>(raw: T): T & Pick<GameState, "containers" | "interactables"> {
  return { ...raw, containers: raw.containers ?? {}, interactables: raw.interactables ?? {} };
}

// ---------- cloning, ids, mutation scaffold ----------

/** Deep clone everything except `maps` (large and never mutated by the engine; shared by reference). */
export function cloneState(s: GameState): GameState {
  const { maps, ...rest } = s;
  return { ...structuredClone(rest), maps };
}

export function newId(s: GameState, prefix: string): string {
  s.nextId += 1;
  return `${prefix}_${s.nextId}`;
}

/** Mutation context: a private clone, the caller's rng and the events produced so far. */
export interface Mut { s: GameState; rng: Rng; ev: EngineEvent[] }

export function emit(m: Mut, e: EngineEvent): void {
  m.ev.push(e);
}

export interface Result<T = undefined> { state: GameState; events: EngineEvent[]; value: T }

function syncCharacters(s: GameState): void {
  for (const e of Object.values(s.entities)) {
    if (e.kind !== "pc") continue;
    const c = s.characters[e.refId];
    if (c) { c.hp = e.hp; c.hp_max = e.hpMax; }
  }
}

/** Clone, run `fn` against the clone, sync the rng, append the events to the log. */
export function run<T>(state: GameState, rng: Rng, fn: (m: Mut) => T): Result<T> {
  const m: Mut = { s: cloneState(state), rng, ev: [] };
  const value = fn(m);
  return finish(m, value);
}

export function finish<T>(m: Mut, value: T): Result<T> {
  const s = m.s;
  s.rngState = m.rng.state();
  syncCharacters(s);
  if (m.ev.length > 0) {
    s.seq += 1;
    s.log = [...s.log, ...m.ev].slice(-RULES.log.maxEvents);
  }
  return { state: s, events: m.ev, value };
}

/** Rebuild the rng stored in the state. After a call, store `rng.state()` back (the engine already does). */
export function rngFromState(s: GameState): Rng {
  return fromState(s.rngState);
}

// ---------- creation ----------

export function createGameState(opts: {
  seed: number; bible: StoryBible; facts: WorldFact[]; contentRating: ContentRating; campaignId?: string;
}): GameState {
  const rng = createRng(opts.seed);
  return {
    v: 1,
    seed: opts.seed,
    campaignId: opts.campaignId ?? `cmp_${Math.abs(opts.seed)}`,
    rngState: rng.state(),
    seq: 0,
    turn: 0,
    nextId: 0,
    bible: structuredClone(opts.bible),
    facts: structuredClone(opts.facts),
    threads: [],
    contentRating: opts.contentRating,
    maps: {},
    currentMapId: null,
    characters: {},
    archetypes: {},
    entities: {},
    npcs: {},
    combat: null,
    terrain: [],
    absentEntityIds: [],
    pendingLevelUps: {},
    spawnCounts: {},
    containers: {},
    interactables: {},
    session: { growthAwarded: {}, lootValueThisEncounter: 0 },
    log: [],
  };
}

// ---------- lookups ----------

export const tileKey = (x: number, y: number): string => `${x},${y}`;

export function sideOf(e: Pick<Entity, "kind" | "disposition">): Side {
  if (e.kind === "pc") return "party";
  if (e.kind === "enemy") return "enemy";
  return e.disposition === "hostile" ? "enemy" : "party";
}

export function currentMap(s: GameState): GameMap | null {
  return s.currentMapId ? s.maps[s.currentMapId] ?? null : null;
}

export function entitiesOnMap(s: GameState, mapId: string): Entity[] {
  return Object.values(s.entities).filter((e) => e.mapId === mapId);
}

/** Tiles occupied by entities (and optionally wall terrain and closed doors) on a map. */
export function occupiedTiles(s: GameState, mapId: string, opts: { exceptId?: string; includeWalls?: boolean } = {}): Set<string> {
  const set = new Set<string>();
  for (const e of Object.values(s.entities)) if (e.mapId === mapId && e.id !== opts.exceptId) set.add(tileKey(e.x, e.y));
  if (opts.includeWalls !== false) {
    for (const t of s.terrain) if (t.mapId === mapId && t.kind === "wall") set.add(tileKey(t.x, t.y));
    for (const k of closedDoorTiles(s, mapId)) set.add(k);
  }
  return set;
}

/** Smoke and wall terrain tiles, and closed or locked doors, block line of sight. */
export function sightBlockers(s: GameState, mapId: string): Set<string> {
  const set = new Set<string>();
  for (const t of s.terrain) if (t.mapId === mapId && (t.kind === "smoke" || t.kind === "wall")) set.add(tileKey(t.x, t.y));
  for (const k of closedDoorTiles(s, mapId)) set.add(k);
  return set;
}

// ---------- interactables: the map object plus what has changed since ----------

export type InteractableObject = Extract<MapObject, { type: "interactable" }>;

export const objectKey = (mapId: string, objectId: string): string => `${mapId}/${objectId}`;

export function interactablesOf(map: GameMap): InteractableObject[] {
  return getObjects(map).filter((o): o is InteractableObject => o.type === "interactable");
}

export function findInteractable(s: GameState, mapId: string, objectId: string): InteractableObject | undefined {
  const map = s.maps[mapId];
  return map ? interactablesOf(map).find((o) => o.id === objectId) : undefined;
}

/** The container made from a map object (a chest or a loot slot), if it has been stocked. */
export function containerForObject(s: GameState, mapId: string, objectId: string): Container | undefined {
  return Object.values(s.containers).find((c) => c.map_id === mapId && c.object_id === objectId);
}

/**
 * The state of an interactable now. A chest's comes from its container (locked, opened or closed); anything else from
 * its override, else the map object. Doors and chests that the map built `locked` stay locked until an override or the container says otherwise.
 */
export function effectiveState(s: GameState, mapId: string, o: InteractableObject): InteractableState {
  if (o.kind === "chest") {
    const c = containerForObject(s, mapId, o.id);
    if (c) return c.locked ? "locked" : c.opened ? "open" : "closed";
  }
  const ov = s.interactables[objectKey(mapId, o.id)];
  const state = ov?.state ?? o.state;
  return state === "locked" && ov?.lock === null ? "closed" : state;
}

/** The lock on an interactable that is locked. A map object built `locked` without a lock gets the default DC. */
export function effectiveLock(s: GameState, mapId: string, o: InteractableObject): Lock | undefined {
  if (effectiveState(s, mapId, o) !== "locked") return undefined;
  const c = o.kind === "chest" ? containerForObject(s, mapId, o.id) : undefined;
  if (c?.lock) return c.lock;
  const ov = s.interactables[objectKey(mapId, o.id)];
  if (ov?.lock) return ov.lock;
  return o.lock ?? { dc: INTERACT.locks.dcByTier[String(INTERACT.locks.defaultTier)] ?? 10 };
}

export function effectiveText(s: GameState, mapId: string, o: InteractableObject): string | undefined {
  return s.interactables[objectKey(mapId, o.id)]?.text ?? o.text;
}

/** Doors that are closed or locked: they block movement and sight until opened. Empty when the data turns this off. */
export function closedDoorTiles(s: GameState, mapId: string): Set<string> {
  const set = new Set<string>();
  const map = s.maps[mapId];
  if (!map || !INTERACT.doors.blockWhenClosed) return set;
  for (const o of interactablesOf(map)) if (o.kind === "door" && effectiveState(s, mapId, o) !== "open") set.add(tileKey(o.x, o.y));
  return set;
}

/** The map as the table should draw it: interactable states, locks and sign text brought up to date. The same object when nothing changed. */
export function effectiveMap(s: GameState, mapId: string): GameMap | null {
  const map = s.maps[mapId];
  if (!map) return null;
  let changed = false;
  const objects = getObjects(map).map((o): MapObject => {
    if (o.type !== "interactable") return o;
    const state = effectiveState(s, mapId, o);
    const lock = state === "locked" ? effectiveLock(s, mapId, o) : undefined;
    const text = o.kind === "sign" ? effectiveText(s, mapId, o) : undefined;
    const same = state === o.state && (lock?.dc ?? 0) === (o.lock?.dc ?? 0) && (lock !== undefined) === (o.lock !== undefined) && text === o.text;
    if (same) return o;
    changed = true;
    const { lock: _l, text: _t, ...rest } = o;
    return { ...rest, state, ...(lock ? { lock } : {}), ...(text !== undefined ? { text } : {}) };
  });
  if (!changed) return map;
  return { ...map, layers: map.layers.map((l) => (l.type === "objectgroup" ? { ...l, objects } : l)) };
}

/** What a container looks like from outside: where, how full, locked or open. Never its contents. */
export function toContainerSummary(c: Container): ContainerSummary {
  return {
    id: c.id, kind: c.kind, x: c.x, y: c.y, item_count: c.items.length, locked: c.locked === true,
    open: c.kind === "chest" ? c.opened === true : true,
    ...(c.object_id ? { object_id: c.object_id } : {}),
  };
}

/**
 * What changed on a map between two states, in the shape of the `state_diff` fields: containers added or changed (as summaries),
 * containers gone, and interactables (doors, levers, chests) whose state differs. Keys with nothing to report are left out.
 */
export function containerDiff(before: GameState, after: GameState, mapId: string): {
  containers_changed?: ContainerSummary[]; containers_removed?: string[]; interactables_changed?: { map_id: string; id: string; state: InteractableState }[];
} {
  const was = new Map(containerSummaries(before, mapId).map((c) => [c.id, c]));
  const now = containerSummaries(after, mapId);
  const changed = now.filter((c) => JSON.stringify(c) !== JSON.stringify(was.get(c.id)));
  const nowIds = new Set(now.map((c) => c.id));
  const removed = [...was.keys()].filter((id) => !nowIds.has(id));
  const map = after.maps[mapId];
  const states = map
    ? interactablesOf(map).flatMap((o) => {
        const s = effectiveState(after, mapId, o);
        const old = before.maps[mapId] ? effectiveState(before, mapId, o) : undefined;
        return s === old ? [] : [{ map_id: mapId, id: o.id, state: s }];
      })
    : [];
  return {
    ...(changed.length > 0 ? { containers_changed: changed } : {}),
    ...(removed.length > 0 ? { containers_removed: removed } : {}),
    ...(states.length > 0 ? { interactables_changed: states } : {}),
  };
}

/**
 * Summaries of the containers on a map that the table can see: chests, and piles and remains that still hold something.
 * NPC pockets stay private until the owner falls.
 */
export function containerSummaries(s: GameState, mapId: string): ContainerSummary[] {
  return Object.values(s.containers)
    .filter((c) => c.map_id === mapId && c.kind !== "pockets" && (c.kind === "chest" || c.items.length > 0))
    .map(toContainerSummary);
}

export function isFactTrue(s: GameState, subject: string, predicate: string, object: string): boolean {
  const sub = subject.trim().toLowerCase();
  return s.facts.some((f) => f.subject.trim().toLowerCase() === sub && f.predicate === predicate && f.object.trim().toLowerCase() === object);
}

// ---------- characters ----------

export type AddCharacterResult =
  | { ok: true; state: GameState; character: Character; events: EngineEvent[] }
  | { ok: false; errors: string[] };

function isFullCharacter(i: CharacterCreate | Character): i is Character {
  return "user_id" in i || "level" in i || "hp_max" in i;
}

function issuesOf(error: { issues: { path: PropertyKey[]; message: string }[] }): string[] {
  return error.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`);
}

/**
 * Validate and add a player character. Accepts a client `CharacterCreate` (with prebuilt `abilities`;
 * `ability_texts` must go through the forge first) or a full `Character`. Computes level, HP and costs,
 * assigns ids from the state counter. Never throws on bad input.
 */
export function addCharacter(state: GameState, input: CharacterCreate | Character, ownerUserId: string): AddCharacterResult {
  const s = cloneState(state);
  const errors: string[] = [];
  let base: {
    id?: string; name: string; title: string; description: string; key_ability: AbilityScoreKey;
    scores: Character["scores"]; trait_tags: Character["trait_tags"]; sprite_recipe?: SpriteRecipe | undefined;
    abilities: (Ability | AbilityDraft)[]; weapon_tier: number; armor_bonus: number; growth: number; hp?: number;
    inventory: Item[];
  };

  if (isFullCharacter(input)) {
    const p = CharacterSchema.safeParse(input);
    if (!p.success) return { ok: false, errors: issuesOf(p.error) };
    const c = p.data;
    base = { ...c, abilities: c.abilities, hp: c.hp };
    if (levelFromGrowth(c.growth) === 1 && c.level === 1) {
      const pb = validatePointBuy(c.scores);
      if (!pb.ok) errors.push(...pb.errors);
    }
  } else {
    const p = CharacterCreateSchema.safeParse(input);
    if (!p.success) return { ok: false, errors: issuesOf(p.error) };
    const c = p.data;
    if (!c.abilities) return { ok: false, errors: ["ability_texts must be forged into abilities before the character is added"] };
    const pb = validatePointBuy(c.scores);
    if (!pb.ok) errors.push(...pb.errors);
    base = {
      ...c, abilities: c.abilities, weapon_tier: RULES.starting.weaponTier, armor_bonus: RULES.starting.armorBonus,
      growth: 0, inventory: [],
    };
  }

  const growth = base.growth;
  const level = levelFromGrowth(growth);
  const caps = levelCaps(level);
  if (base.weapon_tier > caps.weaponTier) errors.push(`weapon tier ${base.weapon_tier} exceeds level ${level} allowance of ${caps.weaponTier}`);
  if (RULES.armor[String(base.armor_bonus)] === undefined) errors.push(`armor bonus ${base.armor_bonus} is not one of ${Object.keys(RULES.armor).join(", ")}`);

  const id = base.id ?? newId(s, "ch");
  if (s.characters[id]) errors.push(`character id ${id} already exists`);

  // abilities: assign ids, recompute costs
  const used = new Set<string>();
  const abilities: Ability[] = base.abilities.map((a) => {
    const aid0 = typeof a.id === "string" && /^ab_[A-Za-z0-9_-]{1,60}$/.test(a.id) ? a.id : undefined;
    const aid = aid0 === undefined || used.has(aid0) ? newId(s, "ab") : aid0;
    used.add(aid);
    const { cost: _c, ...rest } = a as Ability;
    const ab = { ...rest, v: 1, id: aid, tags: a.tags ?? [] } as Ability;
    ab.cost = abilityCost(ab);
    return ab;
  });
  const va = validateCharacterAbilities(abilities, level);
  errors.push(...va.errors);
  if (errors.length > 0) return { ok: false, errors };

  const hpMaxV = computeHpMax(level, base.scores.con);
  const hp = base.hp !== undefined ? Math.min(hpMaxV, Math.max(0, base.hp)) : hpMaxV;
  const character: Character = {
    v: 1,
    id,
    campaign_id: s.campaignId,
    user_id: ownerUserId,
    name: base.name,
    title: base.title,
    description: base.description,
    key_ability: base.key_ability,
    scores: { ...base.scores },
    trait_tags: [...base.trait_tags] as Character["trait_tags"],
    abilities,
    weapon_tier: base.weapon_tier,
    armor_bonus: base.armor_bonus,
    level,
    growth,
    hp,
    hp_max: hpMaxV,
    sprite_recipe: base.sprite_recipe ?? designSpriteOffline(
      { concept: `${base.title} ${base.description}`.trim() || base.name, name: base.name, role: "pc", kind: "pc" },
      Math.max(1, s.rngState >>> 1),
    ),
    inventory: base.inventory ?? [],
  };
  s.characters[id] = character;
  const rng = fromState(s.rngState);
  return { ok: true, state: finish({ s, rng, ev: [] }, undefined).state, character, events: [] };
}

export function initAbilityCounters(abilities: readonly Ability[]): { cooldowns: Record<string, number>; usesLeft: Record<string, number> } {
  const usesLeft: Record<string, number> = {};
  for (const a of abilities) if (a.id && a.uses_per_rest !== undefined) usesLeft[a.id] = a.uses_per_rest;
  return { cooldowns: {}, usesLeft };
}

export function makePcEntity(c: Character, mapId: string, x: number, y: number): Entity {
  return {
    id: c.id, kind: "pc", name: c.name, mapId, x, y, hp: c.hp, hpMax: c.hp_max, conditions: [], shield: 0,
    sprite: c.sprite_recipe, refId: c.id, ...initAbilityCounters(c.abilities), checkBonuses: [],
  };
}

// ---------- maps, archetypes, placement ----------

export type RegisterArchetypeResult =
  | { ok: true; state: GameState; archetype: Enemy; events: EngineEvent[] }
  | { ok: false; errors: string[] };

/**
 * Store an enemy definition: assigns an `en_` id (from the counter) and ability ids, recomputes ability
 * costs and threat. With `partyLevel`, the stats are also validated and a bad enemy is refused.
 */
export function registerArchetype(state: GameState, enemy: Enemy, partyLevel?: number): RegisterArchetypeResult {
  const s = cloneState(state);
  if (partyLevel !== undefined) {
    const v = validateEnemy(enemy, partyLevel);
    if (!v.ok) return { ok: false, errors: v.errors };
  }
  const id = enemy.id && /^en_[A-Za-z0-9_-]{1,60}$/.test(enemy.id) && !s.archetypes[enemy.id] ? enemy.id : newId(s, "en");
  const used = new Set<string>();
  const abilities = enemy.abilities.map((a) => {
    const aid = a.id && /^ab_[A-Za-z0-9_-]{1,60}$/.test(a.id) && !used.has(a.id) ? a.id : newId(s, "ab");
    used.add(aid);
    const ab = { ...structuredClone(a), id: aid } as Ability;
    ab.cost = abilityCost(ab);
    return ab;
  });
  const archetype: Enemy = { ...structuredClone(enemy), id, abilities };
  archetype.threat = enemyThreat(archetype);
  s.archetypes[id] = archetype;
  return { ok: true, state: finish({ s, rng: fromState(s.rngState), ev: [] }, undefined).state, archetype, events: [] };
}

export function placePartyInternal(m: Mut, mapId: string, spawnName: string, characterIds?: string[]): boolean {
  const s = m.s;
  const map = s.maps[mapId];
  if (!map) return false;
  const spawn = getSpawn(map, spawnName);
  if (!spawn) return false;
  const ids = characterIds ?? Object.keys(s.characters);
  const occupied = occupiedTiles(s, mapId, { includeWalls: true });
  for (const id of ids) {
    const c = s.characters[id];
    if (!c) continue;
    const existing = s.entities[id];
    if (existing) occupied.delete(tileKey(existing.x, existing.y));
    const spot = findFreeTileNear(map, spawn.x, spawn.y, occupied);
    if (!spot) continue;
    occupied.add(tileKey(spot.x, spot.y));
    const from = existing ? { x: existing.x, y: existing.y } : spot;
    if (existing) {
      existing.mapId = mapId; existing.x = spot.x; existing.y = spot.y;
    } else {
      s.entities[id] = makePcEntity(c, mapId, spot.x, spot.y);
    }
    emit(m, { type: "moved", entityId: id, entityName: c.name, from, to: spot, tiles: 0, reason: "scene" });
  }
  return true;
}

/** Put the party's tokens on the named spawn (and free tiles around it) and make that map current. */
export function placePartyOnMap(state: GameState, mapId: string, spawnName = "party_start", characterIds?: string[]): Result<boolean> {
  return run(state, fromState(state.rngState), (m) => {
    const ok = placePartyInternal(m, mapId, spawnName, characterIds);
    if (ok) m.s.currentMapId = mapId;
    return ok;
  });
}

export function setAbsent(state: GameState, ids: string[]): GameState {
  const s = cloneState(state);
  s.absentEntityIds = [...ids];
  return s;
}

// ---------- views ----------

export function toEntityView(state: GameState, e: Entity): EntityView {
  const view: EntityView = {
    id: e.id, kind: e.kind, name: e.name, x: e.x, y: e.y, hp: e.hp, hp_max: e.hpMax,
    conditions: e.conditions.map((c) => ({ condition: c.condition, turns: c.turns })),
    sprite: e.sprite,
  };
  if (e.disposition) view.disposition = e.disposition;
  if (e.kind === "pc") {
    const c = state.characters[e.refId];
    if (c) view.owner_player_id = c.user_id;
  }
  return view;
}

export function toCharacterView(c: Character): CharacterView {
  const { user_id: _u, campaign_id: _c, ...view } = c;
  return view;
}

export interface StateSnapshot {
  seq: number;
  mode: "exploration" | "combat";
  map: GameMap;
  entities: EntityView[];
  party: CharacterView[];
  quests: Quest[];
  combat?: { round: number; order: { entity_id: string; initiative: number }[]; active_id: string };
  /** Containers on the current map. Contents are never in a snapshot; `container_view` carries them. */
  containers: ContainerSummary[];
}

export function toWsCombat(c: CombatState): NonNullable<StateSnapshot["combat"]> {
  return { round: c.round, order: c.order.map((o) => ({ entity_id: o.entity_id, initiative: o.initiative })), active_id: c.active_id };
}

/** The `state_snapshot` payload, or null when there is no current map yet. */
export function toSnapshot(state: GameState): StateSnapshot | null {
  const current = currentMap(state);
  if (!current) return null;
  const map = effectiveMap(state, current.id) ?? current;
  const snap: StateSnapshot = {
    seq: state.seq,
    mode: state.combat ? "combat" : "exploration",
    map,
    entities: entitiesOnMap(state, map.id).map((e) => toEntityView(state, e)),
    party: Object.values(state.characters).map(toCharacterView),
    quests: structuredClone(state.bible.quests),
    containers: containerSummaries(state, map.id),
  };
  if (state.combat) snap.combat = toWsCombat(state.combat);
  return snap;
}

export type { MapBrief };
