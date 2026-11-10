import { CHECK_TAGS, DIFFICULTIES, type Difficulty, type DmAction, type Item, type MapBrief, type NpcRecord } from "@aedm/schemas";
import { clampDc, type CheckRequest } from "./checks.ts";
import { endCombatM, startCombatM } from "./combat.ts";
import { RULES } from "./data.ts";
import type { EngineEvent } from "./events.ts";
import { addGrowthM } from "./growth.ts";
import { applyCondition, archetypeOf, isStanding, removeEntity } from "./mutate.ts";
import type { Rng } from "./rng.ts";
import { levelCaps, lootCap } from "./rules.ts";
import {
  cloneState, emit, finish, isFactTrue, newId, occupiedTiles, placePartyInternal, randomSprite, tileKey,
  type Entity, type GameState, type Mut,
} from "./state.ts";
import { bossThreatCap, encounterBudget, enemyThreat } from "./threat.ts";
import { findFreeTileNear, getObjects, isWalkable } from "./map/index.ts";

export { addMap, placePartyOnMap, registerArchetype } from "./state.ts";

export type CreateEnemyAction = Extract<DmAction, { type: "create_enemy" }>;

export interface DmContext {
  /** Characters currently in the scene / party (growth, loot and checks go to these). */
  presentCharacterIds: string[];
  partyLevel: number;
  /** Difficulty the encounter budget is checked against when spawning. Default: standard. */
  difficulty?: Difficulty;
}

export interface DmApplyResult {
  state: GameState;
  events: EngineEvent[];
  applied: DmAction[];
  rejected: { action: DmAction; reason: string }[];
  /**
   * `request_check` is NOT rolled here. The beat pauses: the server calls `resolveCheck` for each entry,
   * broadcasts the roll events and feeds the `describeEvent` lines back to the DM.
   */
  pendingChecks: CheckRequest[];
  /** `generate_map` briefs. The server runs mapgen, then calls `addMap`. */
  mapBriefs: MapBrief[];
  /** `create_enemy` concepts. The server calls the enemy builder, `clampEnemy`, then `registerArchetype`. */
  enemyConcepts: CreateEnemyAction[];
}

/** Party level for the context: the rounded-down average level of the given characters (minimum 1). */
export function computePartyLevel(state: GameState, characterIds: string[]): number {
  const lv = characterIds.map((id) => state.characters[id]?.level).filter((x): x is number => typeof x === "number");
  if (lv.length === 0) return 1;
  return Math.max(1, Math.floor(lv.reduce((a, b) => a + b, 0) / lv.length));
}

const norm = (s: string) => s.trim().toLowerCase();

function findNpcByName(s: GameState, name: string): NpcRecord | undefined {
  return Object.values(s.npcs).find((n) => norm(n.name) === norm(name) || n.id === name);
}

type Out = Pick<DmApplyResult, "pendingChecks" | "mapBriefs" | "enemyConcepts">;

function handle(m: Mut, a: DmAction, ctx: DmContext, out: Out): string | undefined {
  const s = m.s;
  const present = ctx.presentCharacterIds.filter((id) => s.characters[id]);
  switch (a.type) {
    case "request_check": {
      if (a.target !== "party" && !present.includes(a.target)) return `${a.target} is not a present character`;
      if (a.target === "party" && present.length === 0) return "no characters are present";
      for (const t of a.tags) if (!(CHECK_TAGS as readonly string[]).includes(t)) return `tag ${t} is not allowed`;
      const req: CheckRequest = { target: a.target, ability: a.ability, dc: clampDc(a.dc), tags: a.tags, advantage: a.advantage, reason: a.reason };
      out.pendingChecks.push(req);
      emit(m, { type: "check_requested", target: req.target, ability: req.ability, dc: req.dc, tags: req.tags, reason: req.reason });
      return undefined;
    }

    case "create_npc": {
      const map = s.maps[a.map_id];
      if (!map) return `unknown map ${a.map_id}`;
      if (!isWalkable(map, a.x, a.y)) return `tile (${a.x},${a.y}) is not walkable`;
      if (occupiedTiles(s, a.map_id).has(tileKey(a.x, a.y))) return `tile (${a.x},${a.y}) is occupied`;
      const name = a.name.trim();
      const living = Object.values(s.npcs).find((n) => n.alive !== false && norm(n.name) === norm(name));
      if (living) return `an NPC named ${name} is already alive`;
      if (Object.values(s.characters).some((c) => norm(c.name) === norm(name))) return `${name} is a player character`;
      if (isFactTrue(s, name, "is_alive", "false")) return `the facts say ${name} is dead`;
      const id = newId(s, "npc");
      const disposition = RULES.npc.dispositionByRole[a.role];
      const rec: NpcRecord = {
        id, name, concept: a.concept, role: a.role, map_id: a.map_id, x: a.x, y: a.y, sprite_tags: a.sprite_tags,
        alive: true, ...(disposition ? { disposition } : {}),
      };
      s.npcs[id] = rec;
      const ent: Entity = {
        id, kind: "npc", name, mapId: a.map_id, x: a.x, y: a.y, hp: 1, hpMax: 1, conditions: [], shield: 0,
        sprite: randomSprite(m.rng, name, a.sprite_tags), refId: id, cooldowns: {}, usesLeft: {}, checkBonuses: [],
        ...(disposition ? { disposition } : {}),
      };
      s.entities[id] = ent;
      if (!s.facts.some((f) => norm(f.subject) === norm(name) && f.predicate === "is_alive")) s.facts.push({ subject: name, predicate: "is_alive", object: "true" });
      s.facts = s.facts.filter((f) => !(norm(f.subject) === norm(name) && f.predicate === "located_at"));
      s.facts.push({ subject: name, predicate: "located_at", object: a.map_id });
      emit(m, { type: "npc_created", entityId: id, name, role: a.role, x: a.x, y: a.y });
      return undefined;
    }

    case "npc_say": {
      const rec = s.npcs[a.entity_id];
      const ent = s.entities[a.entity_id];
      const name = rec?.name ?? ent?.name ?? a.entity_id;
      if (rec && rec.alive === false) return `${rec.name} is dead`;
      if (isFactTrue(s, name, "is_alive", "false")) return `the facts say ${name} is dead`;
      if (!ent) return `no creature ${a.entity_id} is here`;
      if (ent.kind === "pc") return "player characters speak for themselves";
      if (ent.mapId !== s.currentMapId) return `${ent.name} is not in the current scene`;
      emit(m, { type: "npc_said", entityId: ent.id, name: ent.name, text: a.text });
      return undefined;
    }

    case "create_enemy": {
      out.enemyConcepts.push(a);
      return undefined;
    }

    case "spawn_entity": {
      const arch = s.archetypes[a.archetype_id];
      if (!arch) return `unknown archetype ${a.archetype_id}`;
      const map = s.maps[a.map_id];
      if (!map) return `unknown map ${a.map_id}`;
      let x = a.x;
      let y = a.y;
      if (a.slot_id !== undefined) {
        const slot = getObjects(map).find((o) => o.type === "entity_slot" && o.id === a.slot_id);
        if (!slot || slot.type !== "entity_slot") return `map ${a.map_id} has no entity slot ${a.slot_id}`;
        if (slot.role !== "enemy" && slot.role !== "boss") return `slot ${a.slot_id} is for ${slot.role}, not enemies`;
        x = slot.x; y = slot.y;
      }
      if (x === undefined || y === undefined) return "no position";
      if (!isWalkable(map, x, y)) return `tile (${x},${y}) is not walkable`;
      const threat = arch.threat ?? enemyThreat(arch);
      const existing = Object.values(s.entities).filter((e) => e.kind === "enemy" && e.mapId === a.map_id && isStanding(e));
      const existingThreat = existing.reduce((sum, e) => sum + (s.archetypes[e.refId]?.threat ?? 0), 0);
      const boss = arch.role === "boss" || existing.some((e) => s.archetypes[e.refId]?.role === "boss");
      const size = Math.max(1, present.length);
      const budget = encounterBudget(size, ctx.partyLevel, ctx.difficulty ?? "standard", { boss });
      const total = existingThreat + threat * a.count;
      if (total > budget + 1e-9) return `threat ${total} would exceed the encounter budget of ${budget}`;
      if (arch.role === "boss" && threat > bossThreatCap(size, ctx.partyLevel)) return "a boss may not exceed 1.5x the standard budget alone";
      const occupied = occupiedTiles(s, a.map_id);
      for (let i = 0; i < a.count; i++) {
        const spot = findFreeTileNear(map, x, y, occupied);
        if (!spot) return "no room to place the creatures";
        occupied.add(tileKey(spot.x, spot.y));
        const n = (s.spawnCounts[arch.id as string] ?? 0);
        s.spawnCounts[arch.id as string] = n + 1;
        const name = a.count > 1 || n > 0 ? `${arch.name} ${String.fromCharCode(65 + (n % 26))}` : arch.name;
        const id = newId(s, "ei");
        s.entities[id] = {
          id, kind: "enemy", name, mapId: a.map_id, x: spot.x, y: spot.y, hp: arch.stats.hp, hpMax: arch.stats.hp,
          conditions: [], shield: 0, sprite: randomSprite(m.rng, arch.name, arch.sprite_tags), refId: arch.id as string,
          disposition: "hostile", cooldowns: {},
          usesLeft: Object.fromEntries(arch.abilities.filter((ab) => ab.id && ab.uses_per_rest !== undefined).map((ab) => [ab.id as string, ab.uses_per_rest as number])),
          checkBonuses: [],
        };
        emit(m, { type: "entity_spawned", entityId: id, name, archetypeId: arch.id as string, x: spot.x, y: spot.y, mapId: a.map_id });
      }
      return undefined;
    }

    case "start_combat": {
      if (s.combat) return "a combat is already active";
      const ids = new Set<string>();
      for (const id of a.participants) {
        const e = s.entities[id];
        if (!e) return `unknown participant ${id}`;
        if (e.kind === "pc" && !present.includes(id)) return `${e.name} is not present`;
        ids.add(id);
      }
      // present characters on the same map always take part
      const mapId = s.entities[a.participants[0] as string]?.mapId;
      for (const id of present) if (s.entities[id] && s.entities[id]!.mapId === mapId) ids.add(id);
      const enemies = [...ids].map((id) => s.entities[id]).filter((e): e is Entity => !!e && e.kind === "enemy");
      const threat = enemies.reduce((sum, e) => sum + (archetypeOf(s, e)?.threat ?? 0), 0);
      const boss = enemies.some((e) => archetypeOf(s, e)?.role === "boss");
      const size = Math.max(1, present.length);
      let difficulty = a.difficulty;
      const rank = DIFFICULTIES.indexOf(difficulty);
      let found: Difficulty | null = null;
      for (const d of DIFFICULTIES.slice(rank)) {
        if (threat <= encounterBudget(size, ctx.partyLevel, d, { boss }) + 1e-9) { found = d; break; }
      }
      if (!found) return `enemy threat ${threat} exceeds even the deadly budget`;
      if (found !== difficulty) {
        emit(m, { type: "note", text: `difficulty raised from ${difficulty} to ${found} to match the enemies' threat` });
        difficulty = found;
      }
      return startCombatM(m, [...ids], difficulty);
    }

    case "end_combat": {
      if (!s.combat) return "no combat is active";
      endCombatM(m, a.reason);
      return undefined;
    }

    case "apply_condition": {
      const t = s.entities[a.target];
      if (!t) return `unknown target ${a.target}`;
      if (a.condition === "shielded") return "shielded needs a shield value; use an ability";
      if (!isStanding(t)) return `${t.name} is down`;
      const caps = levelCaps(ctx.partyLevel);
      const cap = a.condition === "stunned" ? caps.maxStunTurns : caps.maxConditionTurns;
      const turns = Math.min(a.turns, cap);
      if (turns !== a.turns) emit(m, { type: "note", text: `${a.condition} duration capped at ${turns} turn(s) for level ${caps.level}` });
      applyCondition(m, t, a.condition, turns);
      return undefined;
    }

    case "grant_item": {
      const c = s.characters[a.recipient];
      if (!c || !present.includes(a.recipient)) return `${a.recipient} is not a present character`;
      const caps = levelCaps(ctx.partyLevel);
      const isGear = a.item.kind === "weapon" || a.item.kind === "armor";
      let tier = a.item.tier;
      if (isGear) {
        tier ??= 1;
        if (tier > caps.weaponTier) return `tier ${tier} is above the level ${caps.level} allowance of ${caps.weaponTier}`;
      } else {
        tier = undefined;
      }
      const value = a.item.kind === "quest" ? 0 : a.item.value;
      const remaining = lootCap(ctx.partyLevel) - s.session.lootValueThisEncounter;
      if (value > remaining) return `value ${value} exceeds the remaining loot cap of ${Math.max(0, remaining)}`;
      if (c.inventory.length >= RULES.npc.maxInventory) return "inventory is full";
      const item: Item = { id: newId(s, "it"), name: a.item.name, kind: a.item.kind, value, ...(tier !== undefined ? { tier } : {}) };
      c.inventory.push(item);
      s.session.lootValueThisEncounter += value;
      let equipped = false;
      if (a.item.kind === "weapon" && tier !== undefined && tier > c.weapon_tier) { c.weapon_tier = tier; equipped = true; }
      if (a.item.kind === "armor" && tier !== undefined) {
        const bonus = RULES.armorTierBonus[String(tier)] ?? 0;
        if (bonus > c.armor_bonus) { c.armor_bonus = bonus; equipped = true; }
      }
      emit(m, { type: "item_granted", recipient: c.id, recipientName: c.name, itemId: item.id, name: item.name, kind: item.kind, value, ...(tier !== undefined ? { tier } : {}), ...(equipped ? { equipped } : {}) });
      return undefined;
    }

    case "update_quest": {
      const q = s.bible.quests.find((x) => x.id === a.quest_id);
      if (!q) {
        if (a.status !== "new") return `unknown quest ${a.quest_id}`;
        if (s.bible.quests.length >= RULES.npc.maxQuests) return "too many quests";
        s.bible.quests.push({ id: a.quest_id, title: (a.note || a.quest_id).slice(0, 80), status: "new", notes: [] });
        emit(m, { type: "quest_updated", questId: a.quest_id, title: (a.note || a.quest_id).slice(0, 80), status: "new", note: "" });
        return undefined;
      }
      q.status = a.status;
      if (a.note) {
        q.notes.push(a.note);
        if (q.notes.length > RULES.npc.maxQuestNotes) q.notes.shift();
      }
      emit(m, { type: "quest_updated", questId: q.id, title: q.title, status: q.status, note: a.note });
      return undefined;
    }

    case "set_fact": {
      const subject = a.subject.trim();
      const npc = findNpcByName(s, subject);
      const existing = s.facts.find((f) => norm(f.subject) === norm(subject) && f.predicate === a.predicate);
      const record = () => {
        emit(m, { type: "fact_set", subject, predicate: a.predicate, object: a.object });
      };
      if (a.predicate === "is_alive") {
        const wantAlive = a.object === "true";
        if (Object.values(s.characters).some((c) => norm(c.name) === norm(subject))) return "player characters' life is decided by HP, not facts";
        const isDead = existing?.object === "false" || npc?.alive === false;
        if (wantAlive && isDead) return `${subject} is dead and cannot be made alive`;
        if (existing) existing.object = a.object;
        else s.facts.push({ subject, predicate: a.predicate, object: a.object });
        if (!wantAlive && npc) {
          npc.alive = false;
          const ent = s.entities[npc.id];
          if (ent) removeEntity(m, ent.id);
          emit(m, { type: "npc_died", entityId: npc.id, name: npc.name });
        }
        record();
        return undefined;
      }
      if (a.predicate === "located_at") {
        if (!s.maps[a.object]) return `located_at needs a known map id, got ${a.object}`;
      }
      if (a.predicate === "disposition" && npc) {
        npc.disposition = a.object as NpcRecord["disposition"];
        const ent = s.entities[npc.id];
        if (ent) ent.disposition = npc.disposition as Entity["disposition"];
      }
      if (a.predicate === "located_at" || a.predicate === "disposition") {
        if (existing) existing.object = a.object;
        else s.facts.push({ subject, predicate: a.predicate, object: a.object });
        record();
        return undefined;
      }
      // owns and free predicates append, ignoring exact duplicates
      if (s.facts.some((f) => norm(f.subject) === norm(subject) && f.predicate === a.predicate && norm(f.object) === norm(a.object))) return undefined;
      if (s.facts.length >= RULES.npc.maxFacts) return "too many facts";
      s.facts.push({ subject, predicate: a.predicate, object: a.object });
      record();
      return undefined;
    }

    case "generate_map": {
      out.mapBriefs.push(a.brief);
      emit(m, { type: "map_requested", setting: a.brief.setting.name });
      return undefined;
    }

    case "change_scene": {
      if (!s.maps[a.map_id]) return `unknown map ${a.map_id}`;
      if (s.combat) return "cannot change scene during combat";
      if (!placePartyInternal(m, a.map_id, a.entry, present)) return `map ${a.map_id} has no spawn named ${a.entry}`;
      s.currentMapId = a.map_id;
      emit(m, { type: "scene_changed", mapId: a.map_id, entry: a.entry });
      return undefined;
    }

    case "award_growth": {
      const c = s.characters[a.character_id];
      if (!c || !present.includes(a.character_id)) return `${a.character_id} is not a present character`;
      const rec = (s.session.growthAwarded[c.id] ??= { points: 0, count: 0 });
      if (rec.count >= RULES.growth.sessionAwardCap) return `${c.name} already received ${RULES.growth.sessionAwardCap} awards this session`;
      if (rec.points + a.amount > RULES.growth.sessionPointCap) {
        return `${c.name} has ${RULES.growth.sessionPointCap - rec.points} growth points left this session, ${a.amount} requested`;
      }
      rec.points += a.amount;
      rec.count += 1;
      addGrowthM(m, c.id, a.amount);
      emit(m, { type: "growth_awarded", characterId: c.id, name: c.name, amount: a.amount, reason: a.reason, growth: c.growth });
      return undefined;
    }

    case "complete_milestone": {
      const ms = s.bible.milestones.find((x) => x.id === a.milestone_id);
      if (!ms) return `unknown milestone ${a.milestone_id}`;
      if (ms.completed) return `milestone ${a.milestone_id} is already completed`;
      if (present.length === 0) return "no characters are present";
      ms.completed = true;
      emit(m, { type: "milestone_completed", milestoneId: ms.id, description: ms.description });
      for (const id of present) {
        const c = s.characters[id] as NonNullable<(typeof s.characters)[string]>;
        addGrowthM(m, id, RULES.growth.milestoneAward);
        emit(m, { type: "growth_awarded", characterId: id, name: c.name, amount: RULES.growth.milestoneAward, reason: "milestone", growth: c.growth });
      }
      return undefined;
    }

    case "suggest_actions": {
      emit(m, { type: "chips", chips: a.chips });
      return undefined;
    }
  }
}

/**
 * Validate and apply the DM's actions in order. Each action is checked semantically; rejected ones are
 * dropped (with an `action_rejected` event) and the rest still apply. Never throws on bad actions.
 *
 * Decisions: `request_check` is returned in `pendingChecks`, not rolled here. `create_enemy`,
 * `generate_map` need the LLM or mapgen, so they come back in `enemyConcepts` and `mapBriefs`.
 */
export function applyDmActions(state: GameState, rng: Rng, actions: DmAction[], ctx: DmContext): DmApplyResult {
  const m: Mut = { s: cloneState(state), rng, ev: [] };
  const applied: DmAction[] = [];
  const rejected: { action: DmAction; reason: string }[] = [];
  const out: Out = { pendingChecks: [], mapBriefs: [], enemyConcepts: [] };
  for (const a of actions) {
    let reason: string | undefined;
    try {
      reason = handle(m, a, ctx, out);
    } catch (err) {
      reason = `internal error: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (reason) {
      rejected.push({ action: a, reason });
      emit(m, { type: "action_rejected", action: a.type, reason });
    } else {
      applied.push(a);
    }
  }
  const r = finish(m, undefined);
  return { state: r.state, events: r.events, applied, rejected, ...out };
}

