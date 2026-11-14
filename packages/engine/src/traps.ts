/**
 * Map traps: springing, passive spotting and disarming. A trap is an interactable of kind `trap`: `closed` is armed, `open` is
 * sprung or disarmed (harmless). It may be `hidden` until found (see `isHidden`). Pure: dice come from the rng passed in, and
 * `spotCheck` rolls nothing. Numbers live in `data/interact.json` (`traps`). The combat "terrain" traps that abilities leave
 * (`GameState.terrain`, kind `trap`) are a different thing and are not touched here.
 */
import type { CheckTag, DamageType } from "@aedm/schemas";
import { actorOrError, chargeM, reachError } from "./actor.ts";
import { checkModifier, clampDc, rollCharacterCheck } from "./checks.ts";
import { act, type ActionResult } from "./combat.ts";
import { INTERACT } from "./data.ts";
import { rollD20, rollDamage } from "./dice.ts";
import type { EngineEvent } from "./events.ts";
import { hasLineOfSight } from "./map/index.ts";
import { applyDamage, isStanding, saveModifier } from "./mutate.ts";
import { fromState, type Rng } from "./rng.ts";
import {
  effectiveState, emit, findInteractable, interactablesOf, isHidden, objectKey, run, sideOf, sightBlockers, tileKey,
  type Entity, type GameState, type InteractableObject, type Mut,
} from "./state.ts";

const T = INTERACT.traps;
const tierKey = (tier: number): string => String(Math.min(5, Math.max(1, Math.trunc(tier) || 1)));
const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** A trap DC for the loot tier, from data, before variance. */
export const trapDcForTier = (tier: number): number => T.dcByTier[tierKey(tier)] ?? 12;
/** Trap damage dice for the loot tier, from data. */
export const trapDiceForTier = (tier: number): string => T.diceByTier[tierKey(tier)] ?? "1d6";

export interface TrapDetail { dc: number; dice: string; damageType: DamageType }

/** What a trap does: its own details, else the data defaults for the default tier (a trap object made without them). */
export function trapDetail(o: InteractableObject): TrapDetail {
  return {
    dc: clampDc(o.trap?.dc ?? trapDcForTier(T.defaultTier)),
    dice: o.trap?.dice ?? trapDiceForTier(T.defaultTier),
    damageType: o.trap?.damage_type ?? (T.damageTypes[0] as DamageType),
  };
}

/** A trap that has not gone off and has not been disarmed. */
export function isArmedTrap(s: GameState, mapId: string, o: InteractableObject): boolean {
  return o.kind === "trap" && effectiveState(s, mapId, o) === "closed";
}

/** The armed trap on a tile, hidden or not. Only the engine may use this: it is what makes a hidden trap go off. */
export function armedTrapAt(s: GameState, mapId: string, x: number, y: number): InteractableObject | undefined {
  const map = s.maps[mapId];
  return map ? interactablesOf(map).find((o) => o.x === x && o.y === y && isArmedTrap(s, mapId, o)) : undefined;
}

/**
 * Tiles holding a revealed, armed trap on a map, as `x,y` keys (the format of `occupiedTiles`). The server routes party walks around
 * them; allies and enemies avoid them through `hazardTiles`. `findPath` itself is unchanged: a trap tile stays walkable.
 */
export function knownTrapTiles(state: GameState, mapId: string): Set<string> {
  const set = new Set<string>();
  const map = state.maps[mapId];
  if (!map) return set;
  for (const o of interactablesOf(map)) if (isArmedTrap(state, mapId, o) && !isHidden(state, mapId, o)) set.add(tileKey(o.x, o.y));
  return set;
}

/** Player characters and allied NPCs spring map traps. Enemies never do. */
export const springsMapTraps = (e: Pick<Entity, "kind" | "disposition">): boolean => e.kind === "pc" || (e.kind === "npc" && sideOf(e) === "party");

/**
 * The trap goes off on `victim`: it becomes `open` and revealed, the damage dice are rolled, and (with `save`) the victim gets the
 * trap's save for half. A player character rolls the check through the usual machinery; an allied NPC rolls d20 plus its save
 * modifier. Emits `trap_sprung` and then the damage events.
 */
export function springTrapM(m: Mut, victim: Entity, o: InteractableObject, opts: { save: boolean }): void {
  const s = m.s;
  const detail = trapDetail(o);
  const key = objectKey(victim.mapId, o.id);
  s.interactables[key] = { ...(s.interactables[key] ?? {}), state: "open", revealed: true };
  const rolled = rollDamage(m.rng, detail.dice);
  let saved = false;
  if (opts.save) {
    if (victim.kind === "pc") {
      const roll = rollCharacterCheck(m, victim.refId, {
        ability: T.save.ability, dc: detail.dc, tags: [T.save.tag as CheckTag], advantage: "none", reason: "avoid the trap",
      }, detail.dc);
      saved = roll?.success === true;
    } else {
      saved = rollD20(m.rng, "none").kept + saveModifier(s, victim, T.save.ability) >= detail.dc;
    }
  }
  const amount = saved && T.save.halfOnSuccess ? Math.floor(rolled.total / 2) : rolled.total;
  emit(m, { type: "trap_sprung", mapId: victim.mapId, objectId: o.id, x: o.x, y: o.y, victim: victim.id, victimName: victim.name, amount, saved });
  applyDamage(m, victim, amount, { damageType: detail.damageType, dice: rolled.dice, ...(saved ? { note: "saved" } : {}) });
}

/**
 * Called from `enterTile`: an armed trap on the tile the creature just entered goes off when it is a player character or an allied
 * NPC. Returns true when one went off (movement stops).
 */
export function triggerMapTrapM(m: Mut, e: Entity): boolean {
  if (e.hp <= 0 || !springsMapTraps(e)) return false;
  const o = armedTrapAt(m.s, e.mapId, e.x, e.y);
  if (!o) return false;
  springTrapM(m, e, o, { save: true });
  return true;
}

// ---------- passive spotting ----------

/**
 * Passive spotting, with no dice. Every hidden, armed trap within `traps.spotRadius` tiles and in line of sight (closed doors,
 * walls and smoke block it) of a standing player character is revealed when that character's passive score, 10 plus their
 * Wisdom (perception) modifier as `rollCharacterCheck` computes it, reaches the trap's DC. Emits `spotted` for each. Hidden chests
 * are never found this way. Call it after the party moves. Returns the same state, with no events, when nothing was spotted.
 */
export function spotCheck(state: GameState): { state: GameState; events: EngineEvent[] } {
  const spotters = Object.values(state.entities)
    .filter((e) => e.kind === "pc" && isStanding(e) && !state.absentEntityIds.includes(e.id) && !!state.maps[e.mapId])
    .sort((a, b) => a.id.localeCompare(b.id));
  const hits: { spotter: Entity; trap: InteractableObject }[] = [];
  for (const mapId of new Set(spotters.map((e) => e.mapId))) {
    const map = state.maps[mapId];
    if (!map) continue;
    const blockers = sightBlockers(state, mapId);
    const here = spotters.filter((e) => e.mapId === mapId);
    for (const o of interactablesOf(map)) {
      if (o.kind !== "trap" || !isHidden(state, mapId, o) || !isArmedTrap(state, mapId, o)) continue;
      const dc = trapDetail(o).dc;
      const spotter = here.find((p) => {
        if (dist(p, o) > T.spotRadius) return false;
        const mod = checkModifier(state, p.refId, INTERACT.search.ability, [INTERACT.search.tag as CheckTag]);
        return !!mod && 10 + mod.modifier >= dc && hasLineOfSight(map, p, o, blockers);
      });
      if (spotter) hits.push({ spotter, trap: o });
    }
  }
  if (hits.length === 0) return { state, events: [] };
  const r = run(state, fromState(state.rngState), (m) => {
    for (const { spotter, trap } of hits) {
      const key = objectKey(spotter.mapId, trap.id);
      m.s.interactables[key] = { ...(m.s.interactables[key] ?? {}), revealed: true };
      emit(m, { type: "spotted", mapId: spotter.mapId, by: spotter.id, byName: spotter.name, objectId: trap.id, kind: trap.kind, x: trap.x, y: trap.y });
    }
  });
  return { state: r.state, events: r.events };
}

// ---------- disarming ----------

/**
 * Disarm a revealed, armed trap within reach: a rolled check (`traps.disarm`, DEX with the tinkering tag) against the trap's DC.
 * Success makes it harmless (`trap_disarmed`). Failing by `failSpringMargin` or more springs it on the actor, with no save.
 * Any other failure leaves it armed (`disarm_failed`) and the actor may try again. Costs the action in combat.
 */
export function disarm(state: GameState, rng: Rng, actorId: string, objectId: string): ActionResult {
  return act(state, rng, "disarm", (m) => {
    const actor = actorOrError(m, actorId);
    if (typeof actor === "string") return actor;
    const o = findInteractable(m.s, actor.mapId, objectId);
    if (!o || o.kind !== "trap") return "there is no such trap here";
    const reach = reachError(actor, actor.mapId, o);
    if (reach) return reach;
    if (!isArmedTrap(m.s, actor.mapId, o)) return "that trap is already harmless";
    const err = chargeM(m, actor, "disarm");
    if (err) return err;
    const detail = trapDetail(o);
    const roll = rollCharacterCheck(m, actor.refId, {
      ability: T.disarm.ability, dc: detail.dc, tags: [T.disarm.tag as CheckTag], advantage: "none", reason: "disarm the trap",
    }, detail.dc);
    if (roll?.success) {
      const key = objectKey(actor.mapId, o.id);
      m.s.interactables[key] = { ...(m.s.interactables[key] ?? {}), state: "open", revealed: true };
      emit(m, { type: "trap_disarmed", mapId: actor.mapId, objectId: o.id, x: o.x, y: o.y, by: actor.id, byName: actor.name });
    } else if (roll && detail.dc - roll.total >= T.disarm.failSpringMargin) {
      springTrapM(m, actor, o, { save: false });
    } else {
      emit(m, { type: "disarm_failed", mapId: actor.mapId, objectId: o.id, x: o.x, y: o.y, by: actor.id, byName: actor.name });
    }
    return undefined;
  });
}

// ---------- what the table is told ----------

const fillText = (template: string, vars: Record<string, string>): string => template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");

/** The line the table gets for a trap event, from `data/interact.json` (`texts.trap_event`): no ids, coordinates or numbers. */
export function trapEventText(e: Extract<EngineEvent, { type: "spotted" | "trap_sprung" | "trap_disarmed" | "disarm_failed" }>): string {
  const T = INTERACT.texts.trap_event;
  switch (e.type) {
    case "spotted": return fillText(T?.spotted ?? "", { name: e.byName });
    case "trap_sprung": return fillText((e.saved ? T?.sprung_saved : T?.sprung) ?? "", { name: e.victimName });
    case "trap_disarmed": return fillText(T?.disarmed ?? "", { name: e.byName });
    case "disarm_failed": return fillText(T?.disarm_failed ?? "", { name: e.byName });
  }
}

/** Why a walk was refused: the only way there crosses a revealed, armed trap. */
export const trapBlockedText = (): string => INTERACT.texts.trap_event?.blocked ?? "";
