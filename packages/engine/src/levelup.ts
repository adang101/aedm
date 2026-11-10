/**
 * The level-up flow: what a player may choose after a level_up event, and the pure state changes
 * for each choice. Scores go through `applyScoreIncrease`; abilities are validated against the
 * character's level caps, the remaining power budget and the ability count limit.
 */
import type { Ability, AbilityDraft, AbilityScoreKey, AbilityScores } from "@aedm/schemas";
import { abilityCost, validateAbilityForLevel } from "./cost.ts";
import { RULES } from "./data.ts";
import type { EngineEvent } from "./events.ts";
import { applyScoreIncrease, clearIfDone } from "./growth.ts";
import { fromState } from "./rng.ts";
import { levelCaps } from "./rules.ts";
import { cloneState, finish, initAbilityCounters, newId, type GameState } from "./state.ts";

export interface LevelUpView {
  characterId: string;
  level: number;
  scorePoints: number;
  abilityPicks: number;
  budget: number;
  budgetUsed: number;
  perAbilityCap: number;
  caps: { maxAvg: number; maxRadius: number; maxStunTurns: number };
  maxAbilities: number;
  abilities: Ability[];
  scores: AbilityScores;
}

export type LevelUpResult =
  | { ok: true; state: GameState; events: EngineEvent[]; ability?: Ability }
  | { ok: false; state: GameState; events: EngineEvent[]; error: string };

const fail = (state: GameState, error: string): LevelUpResult => ({ ok: false, state, events: [], error });

export function totalAbilityCost(abilities: readonly Ability[]): number {
  return abilities.reduce((n, a) => n + abilityCost(a), 0);
}

/** What the level-up screen needs for one character, or null when the character does not exist. */
export function levelUpView(state: GameState, charId: string): LevelUpView | null {
  const c = state.characters[charId];
  if (!c) return null;
  const p = state.pendingLevelUps[charId];
  const caps = levelCaps(c.level);
  return {
    characterId: charId,
    level: c.level,
    scorePoints: Math.max(0, p?.scorePoints ?? 0),
    abilityPicks: Math.max(0, p?.abilityPicks ?? 0),
    budget: caps.budget,
    budgetUsed: totalAbilityCost(c.abilities),
    perAbilityCap: caps.perAbilityCap,
    caps: { maxAvg: caps.maxAverage, maxRadius: caps.maxRadius, maxStunTurns: caps.maxStunTurns },
    maxAbilities: RULES.abilityLimits.maxAbilitiesPerCharacter,
    abilities: structuredClone(c.abilities),
    scores: { ...c.scores },
  };
}

/** Power budget left for a new or replacement ability (`replacing` frees that ability's cost). */
export function remainingBudget(state: GameState, charId: string, replacingId?: string): number {
  const c = state.characters[charId];
  if (!c) return 0;
  const used = c.abilities.reduce((n, a) => n + (a.id === replacingId ? 0 : abilityCost(a)), 0);
  return levelCaps(c.level).budget - used;
}

/** Spend one pending +1 ability score. Recomputes max HP (CON); defense and DC follow from the scores. */
export function spendScorePoint(state: GameState, charId: string, key: AbilityScoreKey): LevelUpResult {
  const r = applyScoreIncrease(state, charId, key);
  return r.ok ? { ok: true, state: r.state, events: r.events } : fail(state, r.error ?? "could not spend the point");
}

function finalize(a: Ability | AbilityDraft, s: GameState): Ability {
  const { cost: _c, ...rest } = a as Ability;
  const id = typeof a.id === "string" && /^ab_[A-Za-z0-9_-]{1,60}$/.test(a.id) ? a.id : newId(s, "ab");
  const ab = { ...rest, v: 1, id, tags: a.tags ?? [] } as Ability;
  ab.cost = abilityCost(ab);
  return ab;
}


function applyAbilityChoice(state: GameState, charId: string, input: Ability | AbilityDraft, replacingId?: string): LevelUpResult {
  const s = cloneState(state);
  const c = s.characters[charId];
  const p = s.pendingLevelUps[charId];
  if (!c) return fail(state, "unknown character");
  if (!p || p.abilityPicks <= 0) return fail(state, "no ability pick is pending");
  const idx = replacingId === undefined ? -1 : c.abilities.findIndex((a) => a.id === replacingId);
  if (replacingId !== undefined && idx < 0) return fail(state, "no such ability to reforge");
  if (replacingId === undefined && c.abilities.length >= RULES.abilityLimits.maxAbilitiesPerCharacter) {
    return fail(state, `you already know ${RULES.abilityLimits.maxAbilitiesPerCharacter} abilities; reforge one instead`);
  }
  // A fresh id even when replacing: counters (uses, cooldowns) start clean for the new version.
  const fresh = finalize({ ...input, id: undefined } as AbilityDraft, s);
  const v = validateAbilityForLevel(fresh, c.level);
  if (!v.ok) return fail(state, v.errors.join("; "));
  const left = remainingBudget(state, charId, replacingId);
  const cost = abilityCost(fresh);
  if (cost > left) return fail(state, `that ability costs ${cost} but only ${Math.max(0, left)} power budget is left`);

  if (idx >= 0) c.abilities[idx] = fresh;
  else c.abilities.push(fresh);
  p.abilityPicks -= 1;
  const ent = s.entities[charId];
  if (ent) {
    const counters = initAbilityCounters([fresh]);
    if (replacingId) { delete ent.cooldowns[replacingId]; delete ent.usesLeft[replacingId]; }
    Object.assign(ent.usesLeft, counters.usesLeft);
  }
  clearIfDone(s, charId);
  const r = finish({ s, rng: fromState(s.rngState), ev: [] }, undefined);
  return { ok: true, state: r.state, events: r.events, ability: fresh };
}

/** Learn a new ability: consumes one pick, must fit the level caps, the budget and the ability count limit. */
export function addAbilityToCharacter(state: GameState, charId: string, ability: Ability | AbilityDraft): LevelUpResult {
  return applyAbilityChoice(state, charId, ability);
}

/** Replace an existing ability (reforge): consumes one pick; the old ability's cost is freed first. */
export function replaceAbility(state: GameState, charId: string, abilityId: string, ability: Ability | AbilityDraft): LevelUpResult {
  return applyAbilityChoice(state, charId, ability, abilityId);
}

/** Keep the current abilities and clear one pending ability pick. */
export function skipAbilityPick(state: GameState, charId: string): LevelUpResult {
  const s = cloneState(state);
  const p = s.pendingLevelUps[charId];
  if (!s.characters[charId]) return fail(state, "unknown character");
  if (!p || p.abilityPicks <= 0) return fail(state, "no ability pick is pending");
  p.abilityPicks -= 1;
  clearIfDone(s, charId);
  const r = finish({ s, rng: fromState(s.rngState), ev: [] }, undefined);
  return { ok: true, state: r.state, events: r.events };
}

