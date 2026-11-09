import type { AbilityScoreKey, Advantage, CheckTag } from "@aedm/schemas";
import { RULES } from "./data.ts";
import { rollD20 } from "./dice.ts";
import type { EngineEvent } from "./events.ts";
import { emit, run, type GameState, type Mut } from "./state.ts";
import type { Rng } from "./rng.ts";
import { abilityModifier } from "./rules.ts";

export interface CheckRequest {
  /** A character id, or "party". */
  target: string;
  ability: AbilityScoreKey;
  dc: number;
  tags: CheckTag[];
  advantage: Advantage;
  reason: string;
}

export interface CheckRoll {
  who: string;
  whoName: string;
  /** Every d20 rolled (two with advantage or disadvantage). */
  dice: number[];
  kept: number;
  modifier: number;
  tagBonus: number;
  total: number;
  success: boolean;
}

export interface CheckResult {
  target: string;
  ability: AbilityScoreKey;
  dc: number;
  tags: CheckTag[];
  advantage: Advantage;
  reason: string;
  rolls: CheckRoll[];
  successes: number;
  /** Successes needed: 1 for a single character, half of the party (rounded up) for "party". */
  needed: number;
  success: boolean;
}

export function clampDc(dc: number): number {
  return Math.min(RULES.checks.dcMax, Math.max(RULES.checks.dcMin, Math.trunc(dc)));
}

/** Roll one character's check inside a mutation context. */
export function rollCharacterCheck(m: Mut, charId: string, req: Omit<CheckRequest, "target">, dc: number): CheckRoll | null {
  const c = m.s.characters[charId];
  if (!c) return null;
  const ent = m.s.entities[charId];
  const abilityMod = abilityModifier(c.scores[req.ability]);
  const tagBonus = req.tags.some((t) => c.trait_tags.includes(t)) ? RULES.checks.tagBonus : 0;
  let effectBonus = 0;
  if (ent) for (const b of ent.checkBonuses) if (b.tags.some((t) => req.tags.includes(t))) effectBonus = Math.max(effectBonus, b.bonus);
  const modifier = abilityMod + tagBonus + effectBonus;
  const d = rollD20(m.rng, req.advantage);
  const total = d.kept + modifier;
  const success = total >= dc;
  const ev: EngineEvent = {
    type: "roll", kind: "check", who: charId, whoName: c.name,
    label: `${req.ability.toUpperCase()} check${req.tags.length ? ` (${req.tags.join(", ")})` : ""}: ${req.reason}`.slice(0, 120),
    dice: d.dice, modifier, total, target: dc, outcome: success ? "success" : "failure",
  };
  emit(m, ev);
  return { who: charId, whoName: c.name, dice: d.dice, kept: d.kept, modifier, tagBonus: tagBonus + effectBonus, total, success };
}

/**
 * Resolve an ability check (d20 + ability modifier, +2 when a tag matches the character's trait tags,
 * plus any `check_bonus` effect; no criticals). DC is clamped to 5-30.
 *
 * "party": every character in `presentCharacterIds` rolls (default: all characters); the party succeeds
 * when at least half of them succeed (successes * 2 >= rolls). One `roll` event per character.
 * Returns `result: null` and a rejection event if the target is unknown or not present.
 */
export function resolveCheck(
  state: GameState,
  rng: Rng,
  req: CheckRequest,
  opts: { presentCharacterIds?: string[] } = {},
): { state: GameState; events: EngineEvent[]; result: CheckResult | null } {
  const r = run(state, rng, (m) => {
    const present = (opts.presentCharacterIds ?? Object.keys(m.s.characters)).filter((id) => m.s.characters[id]);
    const dc = clampDc(req.dc);
    let ids: string[];
    if (req.target === "party") ids = present;
    else if (present.includes(req.target)) ids = [req.target];
    else ids = [];
    if (ids.length === 0) {
      emit(m, { type: "action_rejected", action: "request_check", reason: `no present character for target ${req.target}` });
      return null;
    }
    const rolls: CheckRoll[] = [];
    for (const id of ids) {
      const roll = rollCharacterCheck(m, id, req, dc);
      if (roll) rolls.push(roll);
    }
    const successes = rolls.filter((x) => x.success).length;
    const single = req.target !== "party";
    const needed = single ? 1 : Math.ceil((rolls.length * RULES.checks.partySuccessNum) / RULES.checks.partySuccessDen);
    const result: CheckResult = {
      target: req.target, ability: req.ability, dc, tags: req.tags, advantage: req.advantage, reason: req.reason,
      rolls, successes, needed, success: successes >= needed,
    };
    return result;
  });
  return { state: r.state, events: r.events, result: r.value };
}
