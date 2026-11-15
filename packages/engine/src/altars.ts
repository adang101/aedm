/**
 * Altars: `interact` gives the character a boon, once per character. The boon is the altar's own (`altar.boon` on the map object)
 * or a deterministic pick from `ALTAR_BOONS` by the map seed, map id and object id. All built from existing primitives (heal,
 * shield, remove conditions); magnitudes live in `data/interact.json` (`altars`).
 */
import { ALTAR_BOONS, type AltarBoon } from "@aedm/schemas";
import { actorOrError, chargeM, reachError } from "./actor.ts";
import { act, type ActionResult } from "./combat.ts";
import { CONDITION_META, INTERACT } from "./data.ts";
import type { EngineEvent } from "./events.ts";
import { applyCondition, applyHeal, removeCondition } from "./mutate.ts";
import { hashSeed, type Rng } from "./rng.ts";
import { emit, findInteractable, objectKey, type Entity, type GameState, type InteractableObject, type Mut } from "./state.ts";

const fill = (template: string, vars: Record<string, string>): string => template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");

/** The altar's boon: the one on the map object, else a pick that is the same every time for this altar. */
export function altarBoonOf(s: GameState, mapId: string, o: InteractableObject): AltarBoon {
  if (o.altar?.boon) return o.altar.boon;
  return ALTAR_BOONS[hashSeed(s.maps[mapId]?.meta.seed ?? 0, mapId, o.id) % ALTAR_BOONS.length] as AltarBoon;
}

/** Whether this character has already taken the altar's boon. */
export const altarUsedBy = (s: GameState, mapId: string, objectId: string, characterId: string): boolean =>
  (s.interactables[objectKey(mapId, objectId)]?.usedBy ?? []).includes(characterId);

function applyBoonM(m: Mut, actor: Entity, boon: AltarBoon): number {
  const cfg = INTERACT.altars.boons;
  if (boon === "mend") {
    return applyHeal(m, actor, Math.max(1, Math.floor((actor.hpMax * cfg.mend.percentMaxHp) / 100)));
  }
  if (boon === "ward") {
    actor.shield = Math.max(actor.shield, cfg.ward.absorb);
    applyCondition(m, actor, "shielded", cfg.ward.turns, "altar");
    emit(m, { type: "shield", target: actor.id, targetName: actor.name, absorb: actor.shield, turns: cfg.ward.turns });
    return actor.shield;
  }
  const harmful = actor.conditions.filter((c) => CONDITION_META[c.condition].hostile).map((c) => c.condition);
  for (const c of harmful) removeCondition(m, actor, c);
  return harmful.length;
}

/**
 * Take an altar's boon. Each character can do it once per altar; a second try is `ok` with an `altar_silent` event and changes
 * nothing (and costs nothing). Costs the action in combat.
 */
export function useAltar(state: GameState, rng: Rng, actorId: string, objectId: string): ActionResult {
  return act(state, rng, "use_altar", (m) => {
    const actor = actorOrError(m, actorId);
    if (typeof actor === "string") return actor;
    const o = findInteractable(m.s, actor.mapId, objectId);
    if (!o || o.kind !== "altar") return "there is no such altar here";
    const reach = reachError(actor, actor.mapId, o);
    if (reach) return reach;
    if (altarUsedBy(m.s, actor.mapId, o.id, actor.id)) {
      emit(m, { type: "altar_silent", mapId: actor.mapId, by: actor.id, byName: actor.name, objectId: o.id });
      return undefined;
    }
    const err = chargeM(m, actor, "altar");
    if (err) return err;
    const key = objectKey(actor.mapId, o.id);
    const ov = m.s.interactables[key] ?? {};
    m.s.interactables[key] = { ...ov, usedBy: [...(ov.usedBy ?? []), actor.id] };
    const boon = altarBoonOf(m.s, actor.mapId, o);
    const amount = applyBoonM(m, actor, boon);
    emit(m, { type: "altar_used", mapId: actor.mapId, by: actor.id, byName: actor.name, objectId: o.id, boon, amount });
    return undefined;
  });
}

/** What to tell the table when a character uses an altar (or finds it silent). */
export function altarText(e: Extract<EngineEvent, { type: "altar_used" | "altar_silent" }>): string {
  const T = INTERACT.texts.altar_use;
  return fill((e.type === "altar_used" ? T?.[e.boon] : T?.silent) ?? "", { name: e.byName });
}
