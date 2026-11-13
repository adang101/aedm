import type { Ability, Condition, Difficulty, Effect, Enemy, Save } from "@aedm/schemas";
import { CONDITION_META, RULES, type Tactic } from "./data.ts";
import { rollD20, rollDamage, rollNotation } from "./dice.ts";
import type { EngineEvent } from "./events.ts";
import {
  abilitiesOf, applyCondition, applyDamage, applyHeal, archetypeOf, attackModifiers, basicAttackRange, breakMorale, canAct,
  canMove, defenseOf, dexScore, enemyTactics, enterTile, getEntity, hasCondition, isLeader, isStanding, leaveCombat,
  removeCondition, removeEntity, reviveAt, saveModifier, speedOf, statsOf, terrainAt, walkPath, weaknessMultiplied, weaponDamageDice,
} from "./mutate.ts";
import type { Rng } from "./rng.ts";
import { abilityModifier, proficiency, saveDc } from "./rules.ts";
import {
  cloneState, currentMap, emit, finish, newId, occupiedTiles, sideOf, sightBlockers, tileKey,
  type CombatState, type Entity, type GameState, type Mut, type TerrainTile,
} from "./state.ts";
import { findPath, getObjects, hasLineOfSight, isWalkable, reachableTiles } from "./map/index.ts";

export interface ActionResult { state: GameState; events: EngineEvent[]; ok: boolean; error?: string }
type Point = { x: number; y: number };
const dist = (a: Point, b: Point) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** Run a validated action. `fn` returns an error string (before rolling anything) to refuse it; the input state is then returned untouched. */
export function act(state: GameState, rng: Rng, name: string, fn: (m: Mut) => string | undefined): ActionResult {
  const m: Mut = { s: cloneState(state), rng, ev: [] };
  const error = fn(m);
  if (error) return { state, events: [{ type: "action_rejected", action: name, reason: error }], ok: false, error };
  if (m.s.combat) announceOutcome(m);
  const r = finish(m, undefined);
  return { state: r.state, events: r.events, ok: true };
}

// ---------- outcome ----------

export function combatOutcome(state: GameState): "victory" | "defeat" | null {
  const c = state.combat;
  if (!c) return null;
  const inFight = c.order.map((o) => state.entities[o.entity_id]).filter((e): e is Entity => !!e);
  const enemiesUp = inFight.some((e) => sideOf(e) === "enemy" && isStanding(e));
  const partyUp = inFight.some((e) => sideOf(e) === "party" && isStanding(e));
  if (!enemiesUp) return "victory";
  if (!partyUp) return "defeat";
  return null;
}

function announceOutcome(m: Mut): void {
  const c = m.s.combat;
  if (!c) return;
  const o = combatOutcome(m.s);
  c.announced ??= {};
  if (o === "victory" && !c.announced.cleared) { c.announced.cleared = true; emit(m, { type: "enemies_cleared" }); }
  if (o === "defeat" && !c.announced.wiped) { c.announced.wiped = true; emit(m, { type: "party_downed" }); }
}

// ---------- turn machinery ----------

function activeEntity(s: GameState): Entity | undefined {
  return s.combat ? s.entities[s.combat.active_id] : undefined;
}

function tickEntity(m: Mut, e: Entity): void {
  for (const c of [...e.conditions]) {
    c.turns -= 1;
    if (c.turns <= 0) removeCondition(m, e, c.condition);
  }
  e.checkBonuses = e.checkBonuses.map((b) => ({ ...b, turns: b.turns - 1 })).filter((b) => b.turns > 0);
  for (const k of Object.keys(e.cooldowns)) {
    const v = (e.cooldowns[k] as number) - 1;
    if (v <= 0) delete e.cooldowns[k];
    else e.cooldowns[k] = v;
  }
}

function tickTerrain(m: Mut): void {
  const keep: TerrainTile[] = [];
  for (const t of m.s.terrain) {
    if (t.turns === null) { keep.push(t); continue; }
    t.turns -= 1;
    if (t.turns <= 0) emit(m, { type: "terrain_removed", kind: t.kind, x: t.x, y: t.y, reason: "expired" });
    else keep.push(t);
  }
  m.s.terrain = keep;
}

function startOfTurnEffects(m: Mut, e: Entity): void {
  const s = m.s;
  for (const t of terrainAt(s, e.mapId, e.x, e.y)) {
    if (t.kind === "fire" && t.dice && e.hp > 0) {
      const r = rollDamage(m.rng, t.dice);
      applyDamage(m, e, r.total, { damageType: t.damageType ?? "fire", dice: r.dice });
    }
  }
  for (const cond of ["burning", "bleeding"] as const) {
    const meta = CONDITION_META[cond].startOfTurnDamage;
    if (!meta || e.hp <= 0 || !hasCondition(e, cond)) continue;
    const r = rollDamage(m.rng, meta.dice);
    const w = weaknessMultiplied(s, e, meta.type, r.total);
    applyDamage(m, e, w.amount, { damageType: meta.type, dice: r.dice });
  }
}

/** Move the cursor to the next entity able to take a turn, handling rounds, downed ticks and skipped turns. */
function advanceTurn(m: Mut): void {
  const s = m.s;
  const c = s.combat as CombatState;
  const maxIter = c.order.length * 4 + 4;
  for (let guard = 0; guard < maxIter; guard++) {
    if (c.order.length === 0) return;
    let next = c.cursor + 1;
    if (next >= c.order.length) {
      next = 0;
      c.round += 1;
      tickTerrain(m);
      emit(m, { type: "round_started", round: c.round });
    }
    c.cursor = next;
    const entry = c.order[next] as { entity_id: string };
    c.active_id = entry.entity_id;
    const e = s.entities[entry.entity_id];
    if (!e) continue;
    if (e.kind === "pc" && e.hp <= 0 && !e.out) {
      e.downedRounds = (e.downedRounds ?? 0) + 1;
      if (e.downedRounds >= RULES.downed.roundsUntilOut) {
        e.out = true;
        emit(m, { type: "out_of_fight", entityId: e.id, entityName: e.name });
      }
      continue;
    }
    if (!isStanding(e)) continue;
    c.turn = { movementLeft: speedOf(s, e), actionUsed: false, quickUsed: false };
    emit(m, { type: "turn_started", entityId: e.id, entityName: e.name, round: c.round });
    startOfTurnEffects(m, e);
    const cur = s.entities[e.id];
    if (!cur || cur.hp <= 0) continue;
    if (!canAct(cur)) {
      emit(m, { type: "note", text: `${cur.name} is ${cur.conditions.map((x) => x.condition).join(", ")} and loses the turn` });
      tickEntity(m, cur);
      emit(m, { type: "turn_ended", entityId: cur.id, entityName: cur.name });
      continue;
    }
    return;
  }
}

function endTurnM(m: Mut): void {
  const e = activeEntity(m.s);
  if (e) {
    tickEntity(m, e);
    emit(m, { type: "turn_ended", entityId: e.id, entityName: e.name });
  }
  advanceTurn(m);
}

// ---------- public: combat lifecycle ----------

export function startCombatM(m: Mut, participantIds: string[], difficulty: Difficulty, opts: { absentEntityIds?: string[] } = {}): string | undefined {
  const s = m.s;
  if (s.combat) return "a combat is already active";
  const ids = [...new Set(participantIds)];
  if (ids.length < 2) return "combat needs at least two participants";
  const ents: Entity[] = [];
  for (const id of ids) {
    const e = s.entities[id];
    if (!e) return `unknown participant ${id}`;
    if (!isStanding(e)) return `${e.name} cannot fight`;
    ents.push(e);
  }
  const mapId = (ents[0] as Entity).mapId;
  if (ents.some((e) => e.mapId !== mapId)) return "participants are on different maps";
  if (!ents.some((e) => sideOf(e) === "party") || !ents.some((e) => sideOf(e) === "enemy")) return "combat needs both sides";
  if (opts.absentEntityIds) s.absentEntityIds = [...opts.absentEntityIds];
  const rolled = ents.map((e) => {
    const bonus = abilityModifier(dexScore(s, e)) + (e.kind === "pc" ? 0 : RULES.initiative.enemyBonus);
    const d = rollD20(m.rng, "none");
    const total = d.kept + bonus;
    emit(m, { type: "roll", kind: "initiative", who: e.id, whoName: e.name, label: "initiative", dice: d.dice, modifier: bonus, total, target: 0, outcome: "success" });
    return { e, total };
  });
  rolled.sort((a, b) =>
    b.total - a.total ||
    dexScore(s, b.e) - dexScore(s, a.e) ||
    (a.e.kind === "pc" ? 0 : 1) - (b.e.kind === "pc" ? 0 : 1) ||
    a.e.id.localeCompare(b.e.id));
  const order = rolled.map((r) => ({ entity_id: r.e.id, initiative: r.total }));
  s.combat = {
    round: 1, order, active_id: (order[0] as { entity_id: string }).entity_id, cursor: -1, difficulty,
    turn: { movementLeft: 0, actionUsed: false, quickUsed: false },
  };
  s.session.lootValueThisEncounter = 0;
  emit(m, { type: "combat_started", order: order.map((o) => ({ ...o })), difficulty, round: 1 });
  advanceTurn(m);
  return undefined;
}

/**
 * Start combat: roll initiative (d20 + DEX modifier; ties go to higher DEX, then players), build the
 * turn order and begin the first turn. `absentEntityIds` lists characters whose players are away
 * (they cannot drop below 1 HP).
 */
export function startCombat(
  state: GameState, rng: Rng, participantIds: string[], difficulty: Difficulty,
  opts: { absentEntityIds?: string[] } = {},
): ActionResult {
  return act(state, rng, "start_combat", (m) => startCombatM(m, participantIds, difficulty, opts));
}

export function endCombat(state: GameState, rng: Rng, reason: "victory" | "flee" | "truce" | "defeat"): ActionResult {
  return act(state, rng, "end_combat", (m) => {
    if (!m.s.combat) return "no combat is active";
    endCombatM(m, reason);
    return undefined;
  });
}

export function endCombatM(m: Mut, reason: "victory" | "flee" | "truce" | "defeat"): void {
  const s = m.s;
  s.combat = null;
  for (const e of Object.values(s.entities)) {
    e.conditions = [];
    e.shield = 0;
    e.cooldowns = {};
    e.checkBonuses = [];
    delete e.morale;
    delete e.bloodied;
    if (e.kind === "pc" && (e.hp <= 0 || e.out)) {
      e.hp = RULES.downed.wakeHp;
      delete e.downedRounds;
      delete e.out;
      emit(m, { type: "woke", entityId: e.id, entityName: e.name, hp: e.hp });
    }
  }
  s.terrain = s.terrain.filter((t) => t.kind === "trap");
  emit(m, { type: "combat_ended", reason });
}

export function endTurn(state: GameState, rng: Rng, entityId?: string): ActionResult {
  return act(state, rng, "end_turn", (m) => {
    const c = m.s.combat;
    if (!c) return "no combat is active";
    if (entityId !== undefined && entityId !== c.active_id) return "it is not that creature's turn";
    endTurnM(m);
    return undefined;
  });
}

// ---------- actor validation ----------

export function actorError(s: GameState, e: Entity | undefined, need: "move" | "action" | "quick" | "none"): string | undefined {
  if (!e) return "unknown creature";
  if (!isStanding(e)) return `${e.name} is down`;
  if (need !== "none" && !(need === "move" ? canMove(e) : canAct(e))) {
    return `${e.name} is ${e.conditions.map((c) => c.condition).join(", ")} and cannot ${need === "move" ? "move" : "act"}`;
  }
  const c = s.combat;
  if (c) {
    if (!c.order.some((o) => o.entity_id === e.id)) return `${e.name} is not in the combat`;
    if (c.active_id !== e.id) return `it is not ${e.name}'s turn`;
    if (need === "action" && c.turn.actionUsed) return "the action for this turn is already used";
    if (need === "quick" && c.turn.quickUsed) return "the quick action for this turn is already used";
  }
  return undefined;
}

// ---------- movement ----------

export function moveEntity(state: GameState, rng: Rng, entityId: string, to: Point): ActionResult {
  return act(state, rng, "move", (m) => {
    const s = m.s;
    const e = getEntity(s, entityId);
    const err = actorError(s, e, "move");
    if (err) return err;
    const ent = e as Entity;
    const map = s.maps[ent.mapId];
    if (!map) return "no map";
    if (!isWalkable(map, to.x, to.y)) return "that tile is not walkable";
    if (ent.x === to.x && ent.y === to.y) return "already there";
    const occupied = occupiedTiles(s, ent.mapId, { exceptId: ent.id });
    const path = findPath(map, { x: ent.x, y: ent.y }, to, occupied);
    if (!path) return "no path to that tile";
    const prone = hasCondition(ent, "prone");
    if (s.combat) {
      const stand = prone ? RULES.turn.standCost : 0;
      const available = Math.min(s.combat.turn.movementLeft, speedOf(s, ent));
      if (path.length + stand > available) {
        return `needs ${path.length + stand} tiles of movement${prone ? " (standing costs " + RULES.turn.standCost + ")" : ""}, ${available} left`;
      }
      if (prone) { removeCondition(m, ent, "prone"); s.combat.turn.movementLeft -= stand; }
    } else {
      if (hasCondition(ent, "rooted")) return `${ent.name} is rooted`;
      if (path.length > RULES.exploration.maxMoveTiles) return "too far";
      if (prone) removeCondition(m, ent, "prone");
    }
    const steps = walkPath(m, ent, path, path.length);
    if (s.combat) s.combat.turn.movementLeft -= steps;
    return undefined;
  });
}

// ---------- attacks ----------

function keyMod(s: GameState, e: Entity): number {
  if (e.kind !== "pc") return 0;
  const c = s.characters[e.refId];
  return c ? abilityModifier(c.scores[c.key_ability]) : 0;
}

function attackBonus(s: GameState, e: Entity): number {
  if (e.kind === "pc") {
    const c = s.characters[e.refId];
    return c ? abilityModifier(c.scores[c.key_ability]) + proficiency(c.level) : 0;
  }
  return statsOf(s, e)?.attack_bonus ?? 0;
}

function casterSaveDc(s: GameState, e: Entity): number {
  if (e.kind === "pc") {
    const c = s.characters[e.refId];
    return c ? saveDc(c.level, c.scores[c.key_ability]) : RULES.saveDcBase;
  }
  return RULES.enemySave.dcBase + (statsOf(s, e)?.attack_bonus ?? 0);
}

interface AttackOutcome { hit: boolean; crit: boolean }

function attackRoll(m: Mut, attacker: Entity, target: Entity, label?: string): AttackOutcome {
  const s = m.s;
  const d = dist(attacker, target);
  const mods = attackModifiers(s, attacker, target, d);
  const roll = rollD20(m.rng, mods.advantage);
  const bonus = attackBonus(s, attacker) + mods.toHit;
  const total = roll.kept + bonus;
  const def = defenseOf(s, target);
  const crit = roll.kept === 20;
  const fumble = roll.kept === 1;
  const hit = crit || (!fumble && total >= def);
  emit(m, {
    type: "roll", kind: "attack", who: attacker.id, whoName: attacker.name,
    label: label ?? `${attacker.name} attacks ${target.name}`, dice: roll.dice, modifier: bonus, total, target: def,
    outcome: crit ? "crit" : fumble ? "fumble" : hit ? "success" : "failure",
  });
  if (!hit) emit(m, { type: "attack_missed", attacker: attacker.id, attackerName: attacker.name, target: target.id, targetName: target.name });
  return { hit, crit };
}

function rangeError(m: Mut, from: Entity, to: Point, range: number): string | undefined {
  const d = dist(from, to);
  if (d > range) return `target is ${d} tiles away, range is ${range}`;
  if (d > 1) {
    const map = currentMapOf(m.s, from);
    if (map && !hasLineOfSight(map, from, to, sightBlockers(m.s, from.mapId))) return "no line of sight";
  }
  return undefined;
}

function currentMapOf(s: GameState, e: Entity) {
  return s.maps[e.mapId] ?? currentMap(s);
}

export function basicAttackM(m: Mut, attackerId: string, targetId: string): string | undefined {
  const s = m.s;
  const a = getEntity(s, attackerId);
  const err = actorError(s, a, "action");
  if (err) return err;
  const att = a as Entity;
  const t = getEntity(s, targetId);
  if (!t) return "unknown target";
  if (t.id === att.id) return "cannot attack yourself";
  if (t.mapId !== att.mapId) return "target is on another map";
  if (t.hp <= 0) return `${t.name} is already down`;
  if (sideOf(t) === sideOf(att)) return "cannot attack an ally";
  const re = rangeError(m, att, t, basicAttackRange(s, att));
  if (re) return re;
  if (s.combat) s.combat.turn.actionUsed = true;
  const r = attackRoll(m, att, t);
  if (r.hit) {
    const rolled = rollDamage(m.rng, weaponDamageDice(s, att), { crit: r.crit });
    const raw = Math.max(RULES.attack.minDamage, rolled.total + keyMod(s, att));
    const type = att.kind === "pc" ? RULES.attack.pcDamageType : RULES.attack.enemyDamageType;
    const w = weaknessMultiplied(s, t, type, raw);
    applyDamage(m, t, w.amount, { source: att, damageType: type, dice: rolled.dice, crit: r.crit, ...(w.note ? { note: w.note } : {}) });
  }
  return undefined;
}

export function basicAttack(state: GameState, rng: Rng, attackerId: string, targetId: string): ActionResult {
  return act(state, rng, "basic_attack", (m) => basicAttackM(m, attackerId, targetId));
}

// ---------- abilities ----------

type Target = string | Point;

function relationOk(affects: "enemies" | "allies" | "all", caster: Entity, t: Entity): boolean {
  if (affects === "all") return true;
  const same = sideOf(caster) === sideOf(t);
  return affects === "allies" ? same : !same;
}

function lineTiles(from: Point, to: Point, length: number, map: Parameters<typeof isWalkable>[0]): Point[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const n = Math.max(Math.abs(dx), Math.abs(dy));
  const out: Point[] = [];
  if (n === 0) return out;
  for (let i = 1; i <= length; i++) {
    const p = { x: from.x + Math.round((dx * i) / n), y: from.y + Math.round((dy * i) / n) };
    if (!isWalkable(map, p.x, p.y)) break;
    out.push(p);
  }
  return out;
}

function coneTiles(from: Point, to: Point, length: number, map: Parameters<typeof isWalkable>[0]): Point[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const out: Point[] = [];
  if (dx === 0 && dy === 0) return out;
  for (let x = from.x - length; x <= from.x + length; x++) {
    for (let y = from.y - length; y <= from.y + length; y++) {
      const vx = x - from.x;
      const vy = y - from.y;
      const d = Math.max(Math.abs(vx), Math.abs(vy));
      if (d < 1 || d > length || !isWalkable(map, x, y)) continue;
      const dot = vx * dx + vy * dy;
      if (dot > 0 && 2 * dot * dot >= (vx * vx + vy * vy) * (dx * dx + dy * dy)) out.push({ x, y });
    }
  }
  return out;
}

function burstTiles(center: Point, radius: number, map: Parameters<typeof isWalkable>[0]): Point[] {
  const out: Point[] = [];
  for (let x = center.x - radius; x <= center.x + radius; x++) {
    for (let y = center.y - radius; y <= center.y + radius; y++) if (isWalkable(map, x, y)) out.push({ x, y });
  }
  return out;
}

interface Area { shape: "single" | "burst" | "line" | "cone"; radius: number; length: number }

function areaOf(e: Effect): Area {
  if ((e.type === "damage" || e.type === "heal" || e.type === "terrain") && e.shape !== "single" && e.shape !== "tile") {
    return { shape: e.shape, radius: e.radius_tiles ?? 1, length: ("length_tiles" in e ? e.length_tiles : undefined) ?? 1 };
  }
  return { shape: "single", radius: 0, length: 0 };
}

function abilityArea(ab: Ability): Area {
  for (const e of ab.effects) {
    const a = areaOf(e);
    if (a.shape !== "single") return a;
  }
  return { shape: "single", radius: 0, length: 0 };
}

function defaultAffects(ab: Ability, e: Effect): "enemies" | "allies" | "all" {
  if (e.affects) return e.affects;
  switch (e.type) {
    case "damage": case "push": case "pull": case "mark": return "enemies";
    case "heal": case "shield": case "check_bonus": return "allies";
    case "condition": {
      if (ab.target === "enemy") return "enemies";
      if (ab.target === "ally" || ab.target === "self") return "allies";
      return CONDITION_META[e.condition].hostile ? "enemies" : "allies";
    }
    default: return "all";
  }
}

export function abilityReady(e: Entity, ab: Ability): string | undefined {
  const id = ab.id as string;
  if ((e.cooldowns[id] ?? 0) > 0) return `${ab.name} is on cooldown (${e.cooldowns[id]})`;
  if (ab.uses_per_rest !== undefined && (e.usesLeft[id] ?? 0) <= 0) return `${ab.name} has no uses left`;
  return undefined;
}

interface Cast {
  caster: Entity;
  ab: Ability;
  point: Point;
  targetEnt: Entity | undefined;
  attacks: Map<string, AttackOutcome>;
  saves: Map<string, boolean>;
  dashAttack: boolean;
}

function entitiesAt(s: GameState, mapId: string, tiles: Point[]): Entity[] {
  const keys = new Set(tiles.map((t) => tileKey(t.x, t.y)));
  return Object.values(s.entities).filter((e) => e.mapId === mapId && keys.has(tileKey(e.x, e.y)));
}

function areaTargets(m: Mut, c: Cast, area: Area): Entity[] {
  const s = m.s;
  const map = s.maps[c.caster.mapId];
  if (!map) return [];
  if (area.shape === "single") return c.targetEnt ? [c.targetEnt] : [];
  const tiles = area.shape === "burst" ? burstTiles(c.point, area.radius, map)
    : area.shape === "line" ? lineTiles(c.caster, c.point, area.length, map)
      : coneTiles(c.caster, c.point, area.length, map);
  return entitiesAt(s, c.caster.mapId, tiles);
}

function saveFor(m: Mut, c: Cast, t: Entity, save: Save): boolean {
  const key = `${t.id}:${save.ability}`;
  const cached = c.saves.get(key);
  if (cached !== undefined) return cached;
  const dc = casterSaveDc(m.s, c.caster);
  const mod = saveModifier(m.s, t, save.ability);
  const d = rollD20(m.rng, "none");
  const total = d.kept + mod;
  const ok = total >= dc;
  emit(m, {
    type: "roll", kind: "save", who: t.id, whoName: t.name, label: `${save.ability.toUpperCase()} save vs ${c.ab.name}`,
    dice: d.dice, modifier: mod, total, target: dc, outcome: ok ? "success" : "failure",
  });
  c.saves.set(key, ok);
  return ok;
}

function firstSave(ab: Ability): Save | undefined {
  for (const e of ab.effects) if ((e.type === "damage" || e.type === "condition") && e.save) return e.save;
  return undefined;
}

function attackFor(m: Mut, c: Cast, t: Entity): AttackOutcome {
  const cached = c.attacks.get(t.id);
  if (cached) return cached;
  const r = attackRoll(m, c.caster, t, `${c.caster.name} uses ${c.ab.name} on ${t.name}`);
  c.attacks.set(t.id, r);
  return r;
}

function fail(m: Mut, c: Cast, reason: string): void {
  emit(m, { type: "effect_failed", entityId: c.caster.id, abilityName: c.ab.name, reason });
}

function freeForMove(m: Mut, e: Entity, p: Point): boolean {
  const map = m.s.maps[e.mapId];
  return !!map && isWalkable(map, p.x, p.y) && !occupiedTiles(m.s, e.mapId, { exceptId: e.id }).has(tileKey(p.x, p.y));
}

function forcedMove(m: Mut, t: Entity, dx: number, dy: number, tiles: number, reason: "push" | "pull", anchor: Point): void {
  const from = { x: t.x, y: t.y };
  let moved = 0;
  for (let i = 0; i < tiles; i++) {
    const nx = t.x + dx;
    const ny = t.y + dy;
    if (reason === "pull" && nx === anchor.x && ny === anchor.y) break;
    if (!freeForMove(m, t, { x: nx, y: ny })) break;
    t.x = nx; t.y = ny; moved++;
    if (enterTile(m, t)) break;
  }
  if (moved > 0) emit(m, { type: "moved", entityId: t.id, entityName: t.name, from, to: { x: t.x, y: t.y }, tiles: moved, reason });
}

function applyEffect(m: Mut, c: Cast, e: Effect): void {
  const s = m.s;
  const caster = c.caster;
  const live = (t: Entity) => t.hp > 0;
  const filter = (ts: Entity[], allowDowned = false) =>
    ts.filter((t) => (allowDowned ? !t.out : live(t)) && relationOk(defaultAffects(c.ab, e), caster, t));

  switch (e.type) {
    case "damage": {
      for (const t of filter(areaTargets(m, c, areaOf(e)))) {
        if (c.dashAttack && e.shape === "single" && dist(caster, t) > 1) { fail(m, c, "did not reach the target"); continue; }
        let crit = false;
        let saved = false;
        if (e.save) saved = saveFor(m, c, t, e.save);
        else if (e.shape === "single") {
          const a = attackFor(m, c, t);
          if (!a.hit) continue;
          crit = a.crit;
        }
        const r = rollDamage(m.rng, e.dice, { crit });
        let amt = r.total;
        if (saved) amt = e.on_save === "half" ? Math.floor(amt / 2) : 0;
        const w = weaknessMultiplied(s, t, e.damage_type, amt);
        if (w.amount > 0 || !saved) applyDamage(m, t, w.amount, { source: caster, damageType: e.damage_type, dice: r.dice, crit, ...(w.note ? { note: w.note } : {}) });
      }
      return;
    }
    case "heal": {
      for (const t of filter(areaTargets(m, c, areaOf(e)), true)) {
        const r = rollDamage(m.rng, e.dice);
        applyHeal(m, t, r.total, caster, r.dice);
      }
      return;
    }
    case "shield": {
      for (const t of filter(areaTargets(m, c, abilityArea(c.ab)))) {
        t.shield = Math.max(t.shield, e.absorb);
        applyCondition(m, t, "shielded", e.duration_turns, caster.id);
        emit(m, { type: "shield", target: t.id, targetName: t.name, absorb: t.shield, turns: e.duration_turns });
      }
      return;
    }
    case "condition":
    case "mark": {
      const cond: Condition = e.type === "mark" ? "marked" : e.condition;
      const turns = e.duration_turns;
      for (const t of filter(areaTargets(m, c, abilityArea(c.ab)))) {
        if (e.type === "condition") {
          if (e.on === "hit") {
            const a = c.attacks.get(t.id);
            if (a && !a.hit) continue;
          } else if (e.on === "failed_save") {
            const sv = e.save ?? firstSave(c.ab);
            if (sv && saveFor(m, c, t, sv)) {
              emit(m, { type: "condition_resisted", target: t.id, targetName: t.name, condition: cond, reason: "saved" });
              continue;
            }
          }
        }
        applyCondition(m, t, cond, turns, caster.id);
      }
      return;
    }
    case "push":
    case "pull": {
      for (const t of filter(areaTargets(m, c, abilityArea(c.ab)))) {
        if (t.id === caster.id) continue;
        let dx = Math.sign(t.x - caster.x);
        let dy = Math.sign(t.y - caster.y);
        if (dx === 0 && dy === 0) continue;
        if (e.type === "pull") { dx = -dx; dy = -dy; }
        forcedMove(m, t, dx, dy, e.tiles, e.type, caster);
      }
      return;
    }
    case "dash": {
      const map = s.maps[caster.mapId];
      if (!map) return;
      if (hasCondition(caster, "rooted")) { fail(m, c, "rooted"); return; }
      const occupied = occupiedTiles(s, caster.mapId, { exceptId: caster.id });
      let best: Point[] | null = null;
      if (c.targetEnt && c.targetEnt.id !== caster.id) {
        for (let ox = -1; ox <= 1; ox++) {
          for (let oy = -1; oy <= 1; oy++) {
            if (ox === 0 && oy === 0) continue;
            const goal = { x: c.targetEnt.x + ox, y: c.targetEnt.y + oy };
            if (goal.x === caster.x && goal.y === caster.y) { best = []; continue; }
            const p = findPath(map, caster, goal, occupied);
            if (p && (best === null || p.length < best.length)) best = p;
          }
        }
      } else {
        best = findPath(map, caster, c.point, occupied);
      }
      if (best === null) { fail(m, c, "no path for the dash"); return; }
      if (e.with_attack) c.dashAttack = true;
      if (best.length > 0) walkPath(m, caster, best, e.tiles, "dash");
      return;
    }
    case "teleport": {
      const map = s.maps[caster.mapId];
      if (!map) return;
      if (dist(caster, c.point) > e.tiles) { fail(m, c, "too far to teleport"); return; }
      if (!freeForMove(m, caster, c.point)) { fail(m, c, "destination is blocked"); return; }
      if (!hasLineOfSight(map, caster, c.point, sightBlockers(s, caster.mapId))) { fail(m, c, "no line of sight"); return; }
      const from = { x: caster.x, y: caster.y };
      caster.x = c.point.x; caster.y = c.point.y;
      emit(m, { type: "moved", entityId: caster.id, entityName: caster.name, from, to: { ...c.point }, tiles: dist(from, c.point), reason: "teleport" });
      enterTile(m, caster);
      return;
    }
    case "reveal": {
      let found = 0;
      for (const t of s.terrain) {
        if (t.mapId === caster.mapId && t.hidden && dist(t, c.point) <= e.radius_tiles) { t.hidden = false; found++; }
      }
      emit(m, { type: "revealed", entityId: caster.id, found });
      return;
    }
    case "disarm": {
      const i = s.terrain.findIndex((t) => t.mapId === caster.mapId && t.kind === "trap" && dist(t, c.point) <= 1);
      if (i < 0) { fail(m, c, "nothing to disarm"); return; }
      const t = s.terrain.splice(i, 1)[0] as TerrainTile;
      emit(m, { type: "terrain_removed", kind: "trap", x: t.x, y: t.y, reason: "disarmed" });
      return;
    }
    case "terrain": {
      const map = s.maps[caster.mapId];
      if (!map) return;
      const area = areaOf(e);
      const tiles = area.shape === "burst" ? burstTiles(c.point, area.radius, map)
        : area.shape === "line" ? lineTiles(caster, c.point, area.length, map)
          : isWalkable(map, c.point.x, c.point.y) ? [c.point] : [];
      const occ = occupiedTiles(s, caster.mapId, { includeWalls: false });
      for (const p of tiles) {
        if (e.kind === "wall" && occ.has(tileKey(p.x, p.y))) continue;
        s.terrain = s.terrain.filter((t) => !(t.mapId === caster.mapId && t.x === p.x && t.y === p.y));
        const tile: TerrainTile = {
          id: newId(s, "tr"), mapId: caster.mapId, x: p.x, y: p.y, kind: e.kind,
          turns: e.kind === "trap" ? null : e.duration_turns ?? 1, ownerId: caster.id, side: sideOf(caster),
          ...(e.dice ? { dice: e.dice } : {}), ...(e.damage_type ? { damageType: e.damage_type } : {}),
          ...(e.kind === "trap" ? { hidden: true } : {}),
        };
        s.terrain.push(tile);
        emit(m, { type: "terrain_added", kind: e.kind, x: p.x, y: p.y, turns: tile.turns });
      }
      return;
    }
    case "check_bonus": {
      for (const t of filter(areaTargets(m, c, abilityArea(c.ab)))) {
        t.checkBonuses.push({ bonus: e.bonus, tags: [...e.tags], turns: e.duration_turns + (s.combat?.active_id === t.id ? 1 : 0) });
        emit(m, { type: "check_bonus_applied", target: t.id, targetName: t.name, bonus: e.bonus, tags: [...e.tags], turns: e.duration_turns });
      }
      return;
    }
  }
}

/** Internal ability use (validates, spends the action and cooldown, resolves effects). Returns an error string to refuse. */
export function useAbilityM(m: Mut, entityId: string, abilityId: string, target: Target): string | undefined {
  const s = m.s;
  const e = getEntity(s, entityId);
  const ab0 = e ? abilitiesOf(s, e).find((a) => a.id === abilityId) : undefined;
  const err = actorError(s, e, ab0?.action === "quick" ? "quick" : "action");
  if (err) return err;
  const caster = e as Entity;
  const ab = ab0;
  if (!ab) return `${caster.name} has no ability ${abilityId}`;
  const ready = abilityReady(caster, ab);
  if (ready) return ready;

  // resolve the target
  let point: Point;
  let targetEnt: Entity | undefined;
  if (ab.target === "self") {
    point = { x: caster.x, y: caster.y };
    targetEnt = caster;
  } else if (typeof target === "string") {
    targetEnt = getEntity(s, target);
    if (!targetEnt || targetEnt.mapId !== caster.mapId) return "unknown target";
    if (targetEnt.hp <= 0 && !(targetEnt.kind === "pc" && !targetEnt.out)) return `${targetEnt.name} is already down`;
    point = { x: targetEnt.x, y: targetEnt.y };
  } else {
    point = { x: target.x, y: target.y };
    const map = s.maps[caster.mapId];
    if (!map || !isWalkable(map, point.x, point.y)) return "that tile is not walkable";
    targetEnt = Object.values(s.entities).find((x) => x.mapId === caster.mapId && x.x === point.x && x.y === point.y);
  }
  if (ab.target === "enemy" && (!targetEnt || sideOf(targetEnt) === sideOf(caster))) return "this ability needs an enemy target";
  if (ab.target === "ally" && (!targetEnt || sideOf(targetEnt) !== sideOf(caster))) return "this ability needs an ally target";
  if (ab.target === "any" && !targetEnt) return "this ability needs a creature target";
  if (ab.target !== "self") {
    const re = rangeError(m, caster, point, ab.range_tiles);
    if (re) return re;
  }

  // spend
  if (s.combat) {
    if (ab.action === "quick") s.combat.turn.quickUsed = true;
    else s.combat.turn.actionUsed = true;
  }
  if (ab.uses_per_rest !== undefined) caster.usesLeft[ab.id as string] = (caster.usesLeft[ab.id as string] ?? 0) - 1;
  else if ((ab.cooldown_turns ?? 0) > 0) caster.cooldowns[ab.id as string] = (ab.cooldown_turns as number) + 1;

  emit(m, {
    type: "ability_used", entityId: caster.id, entityName: caster.name, abilityId: ab.id as string, abilityName: ab.name,
    ...(targetEnt && targetEnt.id !== caster.id ? { target: targetEnt.id, targetName: targetEnt.name } : {}),
  });
  const cast: Cast = { caster, ab, point, targetEnt, attacks: new Map(), saves: new Map(), dashAttack: false };
  for (const eff of ab.effects) {
    if (caster.hp <= 0) break;
    applyEffect(m, cast, eff);
  }
  return undefined;
}

/** Use an ability. `target` is an entity id or a tile. */
export function useAbility(state: GameState, rng: Rng, entityId: string, abilityId: string, target: Target): ActionResult {
  return act(state, rng, "use_ability", (m) => useAbilityM(m, entityId, abilityId, target));
}

// ---------- items, revive, extinguish, rest ----------

export function useItem(state: GameState, rng: Rng, entityId: string, itemId: string, targetId?: string): ActionResult {
  return act(state, rng, "use_item", (m) => {
    const s = m.s;
    const e = getEntity(s, entityId);
    const err = actorError(s, e, "quick");
    if (err) return err;
    const user = e as Entity;
    const c = s.characters[user.refId];
    const idx = c ? c.inventory.findIndex((i) => i.id === itemId) : -1;
    if (!c || idx < 0) return "item not found";
    const item = c.inventory[idx]!;
    if (item.kind !== "consumable" || item.name.toLowerCase() !== RULES.draught.name.toLowerCase()) return `${item.name} cannot be used like that`;
    const t = targetId ? getEntity(s, targetId) : user;
    if (!t || t.mapId !== user.mapId) return "unknown target";
    if (sideOf(t) !== sideOf(user)) return "cannot use that on an enemy";
    if (dist(user, t) > 1) return "target must be adjacent";
    if (t.out) return `${t.name} is out of the fight`;
    if (s.combat) s.combat.turn.quickUsed = true;
    c.inventory.splice(idx, 1);
    emit(m, { type: "item_used", entityId: user.id, entityName: user.name, itemName: item.name });
    const r = rollNotation(m.rng, `${RULES.draught.dice}+${RULES.draught.bonus}`);
    applyHeal(m, t, r.total, user, r.dice);
    return undefined;
  });
}

/** An adjacent ally uses an action for a DC 10 Wisdom check to bring a downed character back at 1 HP. */
export function reviveAlly(state: GameState, rng: Rng, reviverId: string, targetId: string): ActionResult {
  return act(state, rng, "revive", (m) => {
    const s = m.s;
    const r = getEntity(s, reviverId);
    const err = actorError(s, r, "action");
    if (err) return err;
    const rev = r as Entity;
    const t = getEntity(s, targetId);
    if (!t || t.kind !== "pc" || t.hp > 0 || t.out) return "that character is not downed";
    if (t.id === rev.id) return "cannot revive yourself";
    if (dist(rev, t) > 1) return "must be adjacent";
    if (s.combat) s.combat.turn.actionUsed = true;
    const d = rollD20(m.rng, "none");
    const mod = saveModifier(s, rev, RULES.downed.reviveAbility);
    const total = d.kept + mod;
    const ok = total >= RULES.downed.reviveDc;
    emit(m, { type: "roll", kind: "revive", who: rev.id, whoName: rev.name, label: `revive ${t.name}`, dice: d.dice, modifier: mod, total, target: RULES.downed.reviveDc, outcome: ok ? "success" : "failure" });
    if (ok) reviveAt(m, t, RULES.downed.reviveHp);
    return undefined;
  });
}

/** An action puts out burning. */
export function extinguish(state: GameState, rng: Rng, entityId: string): ActionResult {
  return act(state, rng, "extinguish", (m) => {
    const e = getEntity(m.s, entityId);
    const err = actorError(m.s, e, "action");
    if (err) return err;
    const ent = e as Entity;
    if (!hasCondition(ent, "burning")) return `${ent.name} is not burning`;
    if (m.s.combat) m.s.combat.turn.actionUsed = true;
    removeCondition(m, ent, "burning");
    return undefined;
  });
}

/** A safe scene break: half max HP, cooldowns and limited uses reset, conditions cleared, downed characters wake. */
export function rest(state: GameState, rng: Rng): ActionResult {
  return act(state, rng, "rest", (m) => {
    const s = m.s;
    if (s.combat) return "cannot rest during combat";
    let total = 0;
    for (const e of Object.values(s.entities)) {
      e.conditions = []; e.shield = 0; e.cooldowns = {}; e.checkBonuses = [];
      delete e.out;
      const abilities = abilitiesOf(s, e);
      e.usesLeft = {};
      for (const a of abilities) if (a.id && a.uses_per_rest !== undefined) e.usesLeft[a.id] = a.uses_per_rest;
      if (e.kind === "pc") {
        const before = e.hp;
        e.hp = Math.min(e.hpMax, Math.max(e.hp, 0) + Math.floor((e.hpMax * RULES.rest.hpFractionNum) / RULES.rest.hpFractionDen));
        delete e.downedRounds;
        total += e.hp - before;
      }
    }
    emit(m, { type: "rest", hpRestored: total });
    return undefined;
  });
}

/** Per DM beat outside combat: bump the beat counter and tick conditions and timed terrain. */
export function advanceBeat(state: GameState, rng: Rng): ActionResult {
  return act(state, rng, "advance_beat", (m) => {
    const s = m.s;
    s.turn += 1;
    if (!s.combat) {
      for (const e of Object.values(s.entities)) if (e.hp > 0) tickEntity(m, e);
      tickTerrain(m);
    }
    return undefined;
  });
}

// ---------- enemy AI ----------

/** Standing creatures of the other side still in the fight, nearest first, then lowest HP, then id. */
function foesOf(s: GameState, e: Entity): Entity[] {
  const inFight = new Set(s.combat?.order.map((o) => o.entity_id));
  return Object.values(s.entities)
    .filter((x) => x.mapId === e.mapId && inFight.has(x.id) && isStanding(x) && sideOf(x) !== sideOf(e))
    .sort((a, b) => dist(e, a) - dist(e, b) || a.hp - b.hp || a.id.localeCompare(b.id));
}

const isHealer = (s: GameState, f: Entity): boolean => abilitiesOf(s, f).some((ab) => ab.effects.some((x) => x.type === "heal"));

/** The most hurt standing boss or elite on the creature's side, other than itself. */
function leaderOf(s: GameState, e: Entity): Entity | undefined {
  return alliesOf(s, e).find((a) => a.id !== e.id && isStanding(a) && isLeader(s, a));
}

/**
 * Foes in the order this creature prefers to deal with them. Without tactics this is `foesOf`.
 * Each tactic adds one sort key (earlier keys win); the sort is stable so ties keep the default order.
 */
function rankFoes(s: GameState, e: Entity, tactics: ReadonlySet<Tactic>): Entity[] {
  const foes = foesOf(s, e);
  if (tactics.size === 0 || foes.length < 2) return foes;
  const leader = tactics.has("protect_leader") ? leaderOf(s, e) : undefined;
  const mates = tactics.has("pack") ? alliesOf(s, e).filter((a) => a.id !== e.id && a.hp > 0) : [];
  const reach = (s.combat?.turn.movementLeft ?? 0) + Math.max(basicAttackRange(s, e), ...abilitiesOf(s, e).map((ab) => ab.range_tiles));
  const key = (f: Entity): number[] => [
    leader && dist(leader, f) <= RULES.ai.leaderGuardRadius ? 0 : 1,
    tactics.has("target_healer") && isHealer(s, f) ? 0 : 1,
    tactics.has("focus_weakest") && dist(e, f) <= reach ? f.hp / f.hpMax : 2,
    -mates.filter((a) => dist(a, f) <= 1).length,
  ];
  return foes
    .map((f) => ({ f, k: key(f) }))
    .sort((a, b) => {
      const i = a.k.findIndex((v, j) => v !== b.k[j]);
      return i < 0 ? 0 : (a.k[i] as number) - (b.k[i] as number);
    })
    .map((x) => x.f);
}

function alliesOf(s: GameState, e: Entity): Entity[] {
  return Object.values(s.entities)
    .filter((x) => x.mapId === e.mapId && !x.out && sideOf(x) === sideOf(e) && (x.hp > 0 || x.kind === "pc"))
    .sort((a, b) => a.hp / a.hpMax - b.hp / b.hpMax || a.id.localeCompare(b.id));
}

function canReach(m: Mut, from: Entity, to: Point, range: number): boolean {
  return rangeError(m, from, to, range) === undefined;
}

function planAbility(m: Mut, e: Entity, ab: Ability, foes: Entity[]): Target | null {
  const s = m.s;
  const offensive = ab.effects.some((x) =>
    x.type === "damage" || x.type === "push" || x.type === "pull" || x.type === "mark" ||
    (x.type === "condition" && defaultAffects(ab, x) === "enemies"));
  const heals = ab.effects.some((x) => x.type === "heal");
  const buffs = ab.effects.some((x) => x.type === "shield" || (x.type === "condition" && defaultAffects(ab, x) === "allies"));
  if (offensive) {
    if (ab.target === "self") {
      const r = abilityArea(ab).radius || 1;
      return foes.some((f) => dist(e, f) <= r) ? e.id : null;
    }
    for (const f of foes) {
      if (!canReach(m, e, f, ab.range_tiles)) continue;
      if (ab.target === "tile") return { x: f.x, y: f.y };
      if (ab.target === "enemy" || ab.target === "any") return f.id;
    }
    return null;
  }
  if (heals) {
    const need = alliesOf(s, e).find((a) => a.hp * 100 < a.hpMax * RULES.ai.healBelowPct);
    if (!need) return null;
    if (ab.target === "self") return need.id === e.id || abilityArea(ab).shape !== "single" ? e.id : null;
    if (ab.target === "ally" || ab.target === "any") return canReach(m, e, need, ab.range_tiles) ? need.id : null;
    return null;
  }
  if (buffs) {
    const cond = ab.effects.find((x) => x.type === "condition") as Extract<Effect, { type: "condition" }> | undefined;
    if (ab.target === "self") return cond && hasCondition(e, cond.condition) ? null : foes.length > 0 ? e.id : null;
    return null;
  }
  return null;
}

/** Spend movement to stand up if prone. False when the creature cannot move this turn. */
function readyToMove(m: Mut, e: Entity): boolean {
  const c = m.s.combat;
  if (!c || !canMove(e)) return false;
  if (hasCondition(e, "prone") && c.turn.movementLeft >= RULES.turn.standCost) {
    removeCondition(m, e, "prone");
    c.turn.movementLeft -= RULES.turn.standCost;
  }
  return !hasCondition(e, "prone");
}

function walkToward(m: Mut, e: Entity, target: Entity, desired: number): void {
  const s = m.s;
  const map = s.maps[e.mapId];
  const c = s.combat as CombatState;
  if (!map || !readyToMove(m, e)) return;
  const blockers = sightBlockers(s, e.mapId);
  const there = (p: Point) => dist(p, target) <= desired && (dist(p, target) <= 1 || hasLineOfSight(map, p, target, blockers));
  if (there(e)) return;
  const occupied = occupiedTiles(s, e.mapId, { exceptId: e.id });
  let best: Point[] | null = null;
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      if (ox === 0 && oy === 0) continue;
      const goal = { x: target.x + ox, y: target.y + oy };
      if (occupied.has(tileKey(goal.x, goal.y)) || !isWalkable(map, goal.x, goal.y)) continue;
      const p = findPath(map, e, goal, occupied);
      if (p && (best === null || p.length < best.length)) best = p;
    }
  }
  if (!best) return;
  let k = best.length;
  for (let i = 0; i < best.length; i++) {
    if (there(best[i] as Point)) { k = i + 1; break; }
  }
  k = Math.min(k, c.turn.movementLeft);
  if (k > 0) {
    const steps = walkPath(m, e, best, k);
    c.turn.movementLeft -= steps;
  }
}

function aiActions(m: Mut, e: Entity): void {
  const s = m.s;
  const c = s.combat as CombatState;
  const tactics = enemyTactics(s, e);
  const tryAbilities = (): boolean => {
    let used = false;
    for (let pass = 0; pass < 2; pass++) {
      let didOne = false;
      for (const ab of abilitiesOf(s, e)) {
        if (!ab.id || abilityReady(e, ab)) continue;
        if (ab.action === "action" ? c.turn.actionUsed : c.turn.quickUsed) continue;
        const plan = planAbility(m, e, ab, rankFoes(s, e, tactics));
        if (plan === null) continue;
        if (useAbilityM(m, e.id, ab.id, plan) === undefined) { didOne = true; used = true; break; }
      }
      if (!didOne) break;
    }
    return used;
  };
  const tryBasic = (): boolean => {
    if (c.turn.actionUsed) return false;
    const range = basicAttackRange(s, e);
    const taunt = e.conditions.find((x) => x.condition === "taunted");
    const foes = rankFoes(s, e, tactics);
    const pool = taunt?.source ? foes.filter((f) => f.id === taunt.source).concat(foes) : foes;
    for (const f of pool) {
      if (canReach(m, e, f, range) && basicAttackM(m, e.id, f.id) === undefined) return true;
    }
    return false;
  };
  if (hasCondition(e, "burning") && !c.turn.actionUsed && foesOf(s, e).every((f) => dist(e, f) > 1)) {
    removeCondition(m, e, "burning");
    c.turn.actionUsed = true;
  }
  const act1 = tryAbilities();
  const act2 = tryBasic();
  if (act1 || act2) return;
  const target = rankFoes(s, e, tactics)[0];
  if (!target) return;
  const range = basicAttackRange(s, e);
  const leader = tactics.has("protect_leader") ? leaderOf(s, e) : undefined;
  if (leader && dist(e, target) > c.turn.movementLeft + range) walkToward(m, e, leader, RULES.ai.leaderGuardRadius);
  else walkToward(m, e, target, range);
  if (e.hp <= 0) return;
  tryAbilities();
  tryBasic();
}

/** Test morale once per fight when an enemy is hurt below its role's threshold: a d20 must reach the DC to hold. */
function checkMorale(m: Mut, e: Entity, a: Enemy): void {
  const cfg = RULES.ai.morale;
  const base = cfg.breakBelowPct[a.role];
  const tactics = enemyTactics(m.s, e);
  if (e.morale || base === 0 || tactics.has("fearless")) return;
  const pct = base + (tactics.has("cowardly") ? cfg.cowardlyBonusPct : 0);
  if (e.hp * 100 >= e.hpMax * pct) return;
  const d = rollD20(m.rng, "none");
  const held = d.kept >= cfg.checkDc;
  emit(m, { type: "roll", kind: "morale", who: e.id, whoName: e.name, label: "morale", dice: d.dice, modifier: 0, total: d.kept, target: cfg.checkDc, outcome: held ? "success" : "failure" });
  if (held) e.morale = "held";
  else breakMorale(m, e, "hurt");
}

const onMapEdge = (map: Parameters<typeof getObjects>[0], p: Point): boolean =>
  p.x === 0 || p.y === 0 || p.x === map.width - 1 || p.y === map.height - 1 ||
  getObjects(map).some((o) => o.type === "exit" && o.x === p.x && o.y === p.y);

/** A surrendering enemy becomes a wary NPC the DM can talk through, out of the turn order. */
function surrender(m: Mut, e: Entity, a: Enemy): void {
  const s = m.s;
  s.npcs[e.id] = {
    id: e.id, name: e.name, concept: a.concept, role: "bystander", map_id: e.mapId, x: e.x, y: e.y, sprite_tags: a.sprite_tags,
    ...(a.appearance ? { appearance: a.appearance } : {}),
    disposition: "wary", alive: true, last_seen_beat: s.turn,
  };
  Object.assign(e, { kind: "npc", disposition: "wary", refId: e.id });
  leaveCombat(s, e.id);
  emit(m, { type: "surrendered", entityId: e.id, name: e.name, npcId: e.id });
}

/**
 * A broken enemy does not attack. It runs to the reachable tile farthest from its foes; once it is out of
 * reach (far away, or on a map edge or exit) it flees, and if it cannot get any farther it surrenders.
 */
function retreat(m: Mut, e: Entity, a: Enemy): void {
  const s = m.s;
  const c = s.combat as CombatState;
  const map = s.maps[e.mapId];
  const foes = foesOf(s, e);
  const clearance = (p: Point) => Math.min(...foes.map((f) => dist(p, f)));
  const start = clearance(e);
  let best = { d: start, path: [] as Point[] };
  if (map && foes.length > 0 && readyToMove(m, e)) {
    for (const t of reachableTiles(map, e, c.turn.movementLeft, occupiedTiles(s, e.mapId, { exceptId: e.id }))) {
      const d = clearance(t);
      if (d > best.d) best = { d, path: t.path };
    }
    c.turn.movementLeft -= walkPath(m, e, best.path, best.path.length);
  }
  if (e.hp <= 0) return;
  if (!map || foes.every((f) => dist(e, f) >= RULES.ai.morale.fleeDistance) || onMapEdge(map, e)) {
    emit(m, { type: "fled", entityId: e.id, name: e.name });
    removeEntity(m, e.id);
  } else if (best.d <= start) surrender(m, e, a);
}

/**
 * Take a whole turn for a non-player creature: test morale, then move toward a foe, attack or use an ability
 * (or, once broken, run), then end the turn. Works for any entity whose turn it is (the server may also use it for autopilot).
 */
export function enemyTakeTurn(state: GameState, rng: Rng, entityId: string): ActionResult {
  return act(state, rng, "enemy_turn", (m) => {
    const c = m.s.combat;
    if (!c) return "no combat is active";
    if (c.active_id !== entityId) return "it is not that creature's turn";
    const e = m.s.entities[entityId];
    if (!e || !isStanding(e)) return "that creature cannot act";
    const a = archetypeOf(m.s, e);
    if (a) checkMorale(m, e, a);
    if (a && e.morale === "broken") retreat(m, e, a);
    else aiActions(m, e);
    endTurnM(m);
    return undefined;
  });
}

/** Run AI turns until a player character is up (or combat has nothing left to do). */
export function runAiTurns(state: GameState, rng: Rng, opts: { maxTurns?: number; isAiControlled?: (e: Entity) => boolean } = {}): { state: GameState; events: EngineEvent[] } {
  let cur = state;
  const events: EngineEvent[] = [];
  const max = opts.maxTurns ?? 64;
  const ai = opts.isAiControlled ?? ((e: Entity) => e.kind !== "pc");
  for (let i = 0; i < max; i++) {
    const c = cur.combat;
    if (!c) break;
    const e = cur.entities[c.active_id];
    if (!e || !ai(e) || combatOutcome(cur) !== null) break;
    const r = enemyTakeTurn(cur, rng, e.id);
    events.push(...r.events);
    cur = r.state;
    if (!r.ok) break;
  }
  return { state: cur, events };
}

