/** Low-level state mutations shared by combat, abilities and DM actions. All take a `Mut` context. */
import type { Ability, Advantage, Condition, DamageType, Enemy, Enemy as EnemyT } from "@aedm/schemas";
import { CONDITION_META, RULES, type Tactic } from "./data.ts";
import { combineAdvantage, rollDamage } from "./dice.ts";
import { emit, sideOf, tileKey, type ConditionInstance, type Entity, type Mut, type TerrainTile, type GameState } from "./state.ts";
import { abilityModifier, defense as defenseCalc, speed as speedCalc, weaponDice } from "./rules.ts";
import { distance } from "./map/index.ts";

export function getEntity(s: GameState, id: string): Entity | undefined {
  return s.entities[id];
}

export function archetypeOf(s: GameState, e: Entity): EnemyT | undefined {
  return e.kind === "enemy" ? s.archetypes[e.refId] : undefined;
}

export function abilitiesOf(s: GameState, e: Entity): Ability[] {
  if (e.kind === "pc") return s.characters[e.refId]?.abilities ?? [];
  if (e.kind === "enemy") return s.archetypes[e.refId]?.abilities ?? [];
  return [];
}

export function hasCondition(e: Entity, c: Condition): boolean {
  return e.conditions.some((x) => x.condition === c);
}

export function isAbsent(s: GameState, e: Entity): boolean {
  return s.absentEntityIds.includes(e.id);
}

export const isDowned = (e: Entity): boolean => e.kind === "pc" && e.hp <= 0 && !e.out;
/** Can take a turn: alive and not out. */
export const isStanding = (e: Entity): boolean => e.hp > 0 && !e.out;

export function canAct(e: Entity): boolean {
  return isStanding(e) && !e.conditions.some((c) => CONDITION_META[c.condition].canAct === false);
}
export function canMove(e: Entity): boolean {
  return isStanding(e) && !e.conditions.some((c) => CONDITION_META[c.condition].canMove === false);
}

export function defenseOf(s: GameState, e: Entity): number {
  if (e.kind === "pc") {
    const c = s.characters[e.refId];
    if (c) return defenseCalc(c.scores, c.armor_bonus, e.conditions);
  }
  const a = archetypeOf(s, e);
  let d = a ? a.stats.defense : RULES.defense.base;
  if (hasCondition(e, "slowed")) d += CONDITION_META.slowed.defenseDelta ?? 0;
  if (hasCondition(e, "hasted")) d += CONDITION_META.hasted.defenseDelta ?? 0;
  return d;
}

export function speedOf(s: GameState, e: Entity): number {
  if (e.kind === "pc") {
    const c = s.characters[e.refId];
    return speedCalc({ conditions: e.conditions, armorBonus: c?.armor_bonus ?? 0 });
  }
  const a = archetypeOf(s, e);
  return speedCalc({ conditions: e.conditions, baseSpeed: a ? a.stats.speed : RULES.speed.base });
}

/** Ability modifier used for saves and checks. Non-pc creatures use a flat modifier derived from attack bonus. */
export function saveModifier(s: GameState, e: Entity, ability: string): number {
  if (e.kind === "pc") {
    const c = s.characters[e.refId];
    if (c) return abilityModifier(c.scores[ability as keyof typeof c.scores]);
  }
  const a = archetypeOf(s, e);
  return a ? Math.floor((a.stats.attack_bonus * RULES.enemySave.num) / RULES.enemySave.den) : 0;
}

export function dexScore(s: GameState, e: Entity): number {
  if (e.kind === "pc") return s.characters[e.refId]?.scores.dex ?? RULES.initiative.enemyDexScore;
  return RULES.initiative.enemyDexScore;
}

export function isRangedAttacker(s: GameState, e: Entity): boolean {
  if (e.kind === "pc") {
    const c = s.characters[e.refId];
    return !!c && RULES.attack.rangedKeyAbilities.includes(c.key_ability);
  }
  const a = archetypeOf(s, e);
  if (!a) return false;
  return RANGED_RE.test(a.behavior.join(" "));
}

const RANGED_RE = new RegExp(RULES.ai.rangedPattern, "i");
const TACTIC_RES = (Object.entries(RULES.ai.tactics) as [Tactic, string][]).map(([id, src]) => [id, new RegExp(src, "i")] as const);
const NO_TACTICS: ReadonlySet<Tactic> = new Set();

/** Tactics an enemy archetype's `behavior` text asks for. Other creatures have none. Fearless overrides cowardly. */
export function enemyTactics(s: GameState, e: Entity): ReadonlySet<Tactic> {
  const a = archetypeOf(s, e);
  if (!a) return NO_TACTICS;
  const text = a.behavior.join(" ");
  const found = new Set(TACTIC_RES.filter(([, re]) => re.test(text)).map(([id]) => id));
  if (found.has("fearless")) found.delete("cowardly");
  return found;
}

/** An enemy whose archetype role is boss or elite: the creature its side's minions rally around. */
export function isLeader(s: GameState, e: Entity): boolean {
  const role = archetypeOf(s, e)?.role;
  return role !== undefined && RULES.ai.leaderRoles.includes(role);
}

/** The enemy's nerve fails. No-op for fearless or already broken creatures. */
export function breakMorale(m: Mut, e: Entity, reason: "hurt" | "leader_down"): void {
  if (e.morale === "broken" || enemyTactics(m.s, e).has("fearless")) return;
  e.morale = "broken";
  emit(m, { type: "morale_broken", entityId: e.id, name: e.name, reason });
}

export function basicAttackRange(s: GameState, e: Entity): number {
  return isRangedAttacker(s, e) ? RULES.attack.rangedRange : RULES.attack.meleeRange;
}

// ---------- conditions ----------

export function applyCondition(m: Mut, target: Entity, condition: Condition, turns: number, source?: string): boolean {
  if (!isStanding(target) && target.kind !== "pc") return false;
  const active = m.s.combat?.order[m.s.combat.cursor]?.entity_id === target.id;
  const eff = turns + (active ? RULES.turn.ownTurnConditionExtra : 0);
  const existing = target.conditions.find((c) => c.condition === condition);
  if (existing) {
    if (eff <= existing.turns) return false; // same condition does not stack; the longer duration wins
    existing.turns = eff;
    if (source) existing.source = source;
  } else {
    const inst: ConditionInstance = { condition, turns: eff };
    if (source) inst.source = source;
    target.conditions.push(inst);
  }
  emit(m, { type: "condition_applied", target: target.id, targetName: target.name, condition, turns: eff, ...(source ? { source } : {}) });
  return true;
}

export function removeCondition(m: Mut, target: Entity, condition: Condition): void {
  const i = target.conditions.findIndex((c) => c.condition === condition);
  if (i < 0) return;
  target.conditions.splice(i, 1);
  if (condition === "shielded") target.shield = 0;
  emit(m, { type: "condition_ended", target: target.id, targetName: target.name, condition });
}

// ---------- damage, healing, death ----------

/** Take a creature out of the turn order, keeping the cursor on the same turn. */
export function leaveCombat(s: GameState, id: string): void {
  const c = s.combat;
  if (!c) return;
  const i = c.order.findIndex((o) => o.entity_id === id);
  if (i >= 0) {
    c.order.splice(i, 1);
    if (i <= c.cursor) c.cursor -= 1;
  }
}

export function removeEntity(m: Mut, id: string): void {
  delete m.s.entities[id];
  leaveCombat(m.s, id);
}

function defeat(m: Mut, t: Entity): void {
  emit(m, { type: "defeated", entityId: t.id, entityName: t.name });
  if (t.kind === "npc") {
    const rec = m.s.npcs[t.refId];
    if (rec) rec.alive = false;
    m.s.facts = m.s.facts.filter((f) => !(f.subject === t.name && f.predicate === "is_alive"));
    m.s.facts.push({ subject: t.name, predicate: "is_alive", object: "false" });
    emit(m, { type: "npc_died", entityId: t.id, name: t.name });
  }
  removeEntity(m, t.id);
  if (isLeader(m.s, t) && RULES.ai.morale.leaderDownBreaksMinions && m.s.combat) {
    const rest = Object.values(m.s.entities);
    if (rest.some((x) => sideOf(x) === "enemy" && isStanding(x) && isLeader(m.s, x))) return;
    for (const x of rest) if (archetypeOf(m.s, x)?.role === "minion" && isStanding(x)) breakMorale(m, x, "leader_down");
  }
}

export function weaknessMultiplied(s: GameState, target: Entity, type: DamageType | undefined, amount: number): { amount: number; note?: string } {
  const a = archetypeOf(s, target);
  if (!a || !type) return { amount };
  let out = amount;
  let note: string | undefined;
  const w = a.weakness;
  if (w && (w === type || (hasCondition(target, w as Condition)))) {
    out = Math.floor((out * RULES.damage.weaknessNum) / RULES.damage.weaknessDen);
    note = "weakness";
  }
  if (a.resistance === type) {
    out = Math.floor((out * RULES.damage.resistanceNum) / RULES.damage.resistanceDen);
    note = "resistance";
  }
  return note ? { amount: out, note } : { amount: out };
}

export interface DamageOpts { source?: Entity; damageType?: DamageType; dice?: number[]; crit?: boolean; note?: string }

/** Apply final damage (weakness/resistance already included). Returns HP actually lost. */
export function applyDamage(m: Mut, target: Entity, amount: number, opts: DamageOpts = {}): number {
  if (target.hp <= 0) return 0;
  let remaining = Math.max(0, Math.trunc(amount));
  let absorbed = 0;
  if (target.shield > 0 && remaining > 0) {
    absorbed = Math.min(target.shield, remaining);
    target.shield -= absorbed;
    remaining -= absorbed;
    if (target.shield === 0) removeCondition(m, target, "shielded");
  }
  const floor = isAbsentEntity(m.s, target) ? RULES.downed.absentMinHp : 0;
  const before = target.hp;
  target.hp = Math.max(floor, target.hp - remaining);
  const lost = before - target.hp;
  emit(m, {
    type: "damage", target: target.id, targetName: target.name, amount: lost, absorbed, hp: target.hp, hpMax: target.hpMax,
    ...(opts.source ? { source: opts.source.id, sourceName: opts.source.name } : {}),
    ...(opts.damageType ? { damageType: opts.damageType } : {}),
    ...(opts.dice ? { dice: opts.dice } : {}),
    ...(opts.crit ? { crit: true } : {}),
    ...(opts.note ? { modifier: opts.note } : {}),
  });
  if (target.hp <= 0) {
    if (target.kind === "pc") {
      target.conditions = [];
      target.shield = 0;
      target.conditions.push({ condition: "prone", turns: 99 });
      target.downedRounds = 0;
      emit(m, { type: "downed", entityId: target.id, entityName: target.name });
    } else {
      defeat(m, target);
    }
  } else if (m.s.combat && !target.bloodied && isLeader(m.s, target) && target.hp * 100 < target.hpMax * RULES.ai.morale.bloodiedPct) {
    target.bloodied = true;
    emit(m, { type: "bloodied", entityId: target.id, entityName: target.name });
  }
  return lost;
}

function isAbsentEntity(s: GameState, e: Entity): boolean {
  return e.kind === "pc" && s.absentEntityIds.includes(e.id);
}

/** Heal; revives a downed pc with that many HP; any healing ends bleeding. */
export function applyHeal(m: Mut, target: Entity, amount: number, source?: Entity, dice?: number[]): number {
  if (target.out || amount <= 0) return 0;
  const wasDowned = target.hp <= 0 && target.kind === "pc";
  const before = target.hp;
  target.hp = Math.min(target.hpMax, target.hp + amount);
  const gained = target.hp - before;
  emit(m, {
    type: "heal", target: target.id, targetName: target.name, amount: gained, hp: target.hp, hpMax: target.hpMax,
    ...(source ? { source: source.id, sourceName: source.name } : {}),
    ...(dice ? { dice } : {}),
  });
  if (wasDowned && target.hp > 0) {
    delete target.downedRounds;
    emit(m, { type: "revived", entityId: target.id, entityName: target.name, hp: target.hp });
  }
  if (CONDITION_META.bleeding.endsOnHeal && hasCondition(target, "bleeding")) removeCondition(m, target, "bleeding");
  return gained;
}

/** Revive a downed pc at a fixed HP without healing math (DC 10 Wisdom check by an ally). */
export function reviveAt(m: Mut, target: Entity, hp: number): void {
  if (!(target.kind === "pc" && target.hp <= 0 && !target.out)) return;
  target.hp = Math.min(target.hpMax, hp);
  delete target.downedRounds;
  emit(m, { type: "revived", entityId: target.id, entityName: target.name, hp: target.hp });
}

// ---------- attack modifiers ----------

/** Advantage sources and flat bonus for an attack, from the conditions on both sides. */
export function attackModifiers(s: GameState, attacker: Entity, target: Entity, dist: number): { advantage: Advantage; toHit: number } {
  const src: Advantage[] = [];
  let toHit = 0;
  const at = (c: Condition) => hasCondition(target, c);
  if (at("stunned") && CONDITION_META.stunned.attackedAdvantage) src.push("advantage");
  if (at("prone")) {
    if (dist <= 1 && CONDITION_META.prone.adjacentAttackAdvantage) src.push("advantage");
    if (dist > 1 && CONDITION_META.prone.rangedAttackDisadvantage) src.push("disadvantage");
  }
  if (at("evasive") && CONDITION_META.evasive.attackedDisadvantage) src.push("disadvantage");
  if (at("marked")) toHit += CONDITION_META.marked.attackedToHit ?? 0;
  if (hasCondition(attacker, "dazzled")) src.push("disadvantage");
  const taunt = attacker.conditions.find((c) => c.condition === "taunted");
  if (taunt && taunt.source !== target.id) src.push("disadvantage");
  return { advantage: combineAdvantage(src), toHit };
}

export function weaponDamageDice(s: GameState, e: Entity): string {
  if (e.kind === "pc") return weaponDice(s.characters[e.refId]?.weapon_tier ?? 1);
  return archetypeOf(s, e)?.stats.damage_dice ?? "1d4";
}

// ---------- terrain triggers ----------

/** Called when an entity enters a tile. Returns true if movement should stop (trap sprung). */
export function enterTile(m: Mut, e: Entity): boolean {
  const s = m.s;
  let stop = false;
  for (const t of [...s.terrain]) {
    if (t.mapId !== e.mapId || t.x !== e.x || t.y !== e.y) continue;
    if (t.kind === "trap") {
      if (t.side === sideOf(e)) continue; // traps spare the owner's side
      s.terrain.splice(s.terrain.indexOf(t), 1);
      emit(m, { type: "terrain_removed", kind: "trap", x: t.x, y: t.y, reason: "sprung" });
      if (t.dice) {
        const r = rollDamage(m.rng, t.dice);
        applyDamage(m, e, r.total, { damageType: t.damageType ?? "sharp", dice: r.dice });
      }
      stop = true;
    } else if (t.kind === "fire") {
      if (t.dice) {
        const r = rollDamage(m.rng, t.dice);
        applyDamage(m, e, r.total, { damageType: t.damageType ?? "fire", dice: r.dice });
      }
    }
  }
  return stop || e.hp <= 0;
}

export function terrainAt(s: GameState, mapId: string, x: number, y: number): TerrainTile[] {
  return s.terrain.filter((t) => t.mapId === mapId && t.x === x && t.y === y);
}

/** Step an entity along `path`, at most `maxSteps` tiles, springing traps and stopping when downed. Returns steps taken. */
export function walkPath(m: Mut, e: Entity, path: { x: number; y: number }[], maxSteps: number, reason: "walk" | "dash" = "walk"): number {
  const from = { x: e.x, y: e.y };
  let steps = 0;
  for (const p of path) {
    if (steps >= maxSteps) break;
    e.x = p.x;
    e.y = p.y;
    steps++;
    if (enterTile(m, e)) break;
  }
  if (steps > 0) emit(m, { type: "moved", entityId: e.id, entityName: e.name, from, to: { x: e.x, y: e.y }, tiles: steps, reason });
  return steps;
}

export function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return distance(a, b);
}

export { tileKey };
export type { Enemy };
