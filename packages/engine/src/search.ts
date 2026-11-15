/**
 * Searching: one Wisdom (perception) roll that tries to find every hidden trap or chest near the searcher. Each character tries
 * each object once. The table is never told whether anything hidden exists: a roll that finds nothing and a search with nothing
 * left to roll against read the same (`searchedText`). Numbers and phrasing live in `data/interact.json` (`search`, `texts.search`).
 */
import type { CheckTag } from "@aedm/schemas";
import { actorOrError, chargeM } from "./actor.ts";
import { checkModifier, clampDc } from "./checks.ts";
import { act, type ActionResult } from "./combat.ts";
import { partyLevelOf } from "./containers.ts";
import { INTERACT } from "./data.ts";
import { rollD20 } from "./dice.ts";
import type { EngineEvent } from "./events.ts";
import { lootTierForLevel } from "./loot.ts";
import type { Rng } from "./rng.ts";
import { emit, interactablesOf, isHidden, objectKey, type GameState, type InteractableObject } from "./state.ts";
import { trapDetail } from "./traps.ts";

const S = INTERACT.search;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const fill = (template: string, vars: Record<string, string>): string => template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");

/** The DC of finding a hidden object by searching: a trap's own DC; a chest's from `search.cacheDcByTier` at the party's loot tier. */
export function searchDc(s: GameState, o: InteractableObject): number {
  if (o.kind === "trap") return trapDetail(o).dc;
  const tier = String(Math.min(5, Math.max(1, lootTierForLevel(partyLevelOf(s)))));
  return clampDc(S.cacheDcByTier[tier] ?? 10);
}

/**
 * Search around the actor: one WIS check (tag `perception`). Every hidden trap or chest within `search.radius` tiles that this
 * character has not already failed to find is revealed when the roll total reaches its DC; otherwise the character is remembered
 * (`searchedBy`) and cannot try that object again. One `searched` event. With nothing left to roll against, no die is rolled and
 * the event says `nothingNew`. No `roll` event is emitted, since it would show a DC. Costs the action in combat, nothing outside it.
 */
export function search(state: GameState, rng: Rng, actorId: string): ActionResult {
  return act(state, rng, "search", (m) => {
    const actor = actorOrError(m, actorId);
    if (typeof actor === "string") return actor;
    const map = m.s.maps[actor.mapId];
    if (!map) return "no map";
    const err = chargeM(m, actor, "search");
    if (err) return err;
    const open = interactablesOf(map).filter((o) => {
      if (!isHidden(m.s, actor.mapId, o) || dist(actor, o) > S.radius) return false;
      return !(m.s.interactables[objectKey(actor.mapId, o.id)]?.searchedBy ?? []).includes(actor.id);
    });
    if (open.length === 0) {
      emit(m, { type: "searched", mapId: actor.mapId, by: actor.id, byName: actor.name, found: [], nothingNew: true });
      return undefined;
    }
    const mod = checkModifier(m.s, actor.refId, S.ability, [S.tag as CheckTag]);
    const total = rollD20(m.rng, "none").kept + (mod?.modifier ?? 0);
    const found: { objectId: string; kind: string; x: number; y: number }[] = [];
    for (const o of open) {
      const key = objectKey(actor.mapId, o.id);
      const ov = m.s.interactables[key] ?? {};
      if (total >= searchDc(m.s, o)) {
        m.s.interactables[key] = { ...ov, revealed: true };
        found.push({ objectId: o.id, kind: o.kind, x: o.x, y: o.y });
      } else {
        m.s.interactables[key] = { ...ov, searchedBy: [...(ov.searchedBy ?? []), actor.id] };
      }
    }
    emit(m, { type: "searched", mapId: actor.mapId, by: actor.id, byName: actor.name, total, found });
    return undefined;
  });
}

/**
 * What to tell the table about a search. A search that rolled and found nothing and one with nothing to roll against give the
 * same words; the roll total and `nothingNew` are never shown.
 */
export function searchedText(e: Extract<EngineEvent, { type: "searched" }>): string {
  const T = INTERACT.texts.search;
  if (e.found.length === 0) return fill(T?.nothing ?? "", { name: e.byName });
  return fill(T?.found ?? "", { name: e.byName, list: e.found.map((f) => `a ${f.kind}`).join(", ") });
}
