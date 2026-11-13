/** Shared checks for acting on the world: who may act, what it costs in combat, and how close they must stand. */
import { INTERACT, type ActionCost } from "./data.ts";
import { actorError } from "./combat.ts";
import { isStanding } from "./mutate.ts";
import { type Entity, type Mut } from "./state.ts";

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** The player character with this id, if it can act in the world. Errors come back as a string, never thrown. */
export function actorOrError(m: Mut, actorId: string): Entity | string {
  const e = m.s.entities[actorId];
  if (!e) return "unknown creature";
  if (e.kind !== "pc" || !m.s.characters[e.refId]) return "only a player character can do that";
  if (!isStanding(e)) return `${e.name} is down`;
  return e;
}

/**
 * Charge the verb's cost (`interact.json` `combatCost`). Outside combat it is free; in combat an `action` or `quick` verb
 * must be the actor's own turn with that slot unused and is spent here, `free` verbs only need the actor standing,
 * and `refuse` verbs are not allowed. Call it first: a refused action returns the original state, so nothing is lost.
 */
export function chargeM(m: Mut, actor: Entity, verb: string): string | undefined {
  const cost: ActionCost = INTERACT.combatCost[verb] ?? "action";
  const c = m.s.combat;
  if (!c) {
    if (cost === "free") return undefined;
    return actorError(m.s, actor, "action");
  }
  if (cost === "free") return undefined;
  if (cost === "refuse") return `${verb} is not possible during combat`;
  const err = actorError(m.s, actor, cost === "quick" ? "quick" : "action");
  if (err) return err;
  if (cost === "quick") c.turn.quickUsed = true;
  else c.turn.actionUsed = true;
  return undefined;
}

/** An error when the actor is on another map or farther than `reach` tiles (Chebyshev) from the point. */
export function reachError(actor: Entity, mapId: string, at: { x: number; y: number }, reach: number = INTERACT.reach): string | undefined {
  if (actor.mapId !== mapId) return "that is not here";
  if (dist(actor, at) > reach) return reach <= 1 ? "you must be next to it" : `you must be within ${reach} tiles`;
  return undefined;
}
