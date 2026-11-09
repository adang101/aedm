import type { AbilityScoreKey } from "@aedm/schemas";
import { RULES } from "./data.ts";
import type { EngineEvent } from "./events.ts";
import { cloneState, emit, finish, type GameState, type Mut } from "./state.ts";
import { fromState } from "./rng.ts";
import { hpMax as computeHpMax, levelFromGrowth } from "./rules.ts";

/** Add growth points to a character and apply any level-ups (HP, pending ability picks, score points). */
export function addGrowthM(m: Mut, charId: string, amount: number): void {
  const s = m.s;
  const c = s.characters[charId];
  if (!c) return;
  c.growth += amount;
  const target = levelFromGrowth(c.growth);
  while (c.level < target) {
    c.level += 1;
    const newMax = computeHpMax(c.level, c.scores.con);
    const gain = Math.max(0, newMax - c.hp_max);
    c.hp_max = newMax;
    const ent = s.entities[charId];
    if (ent) {
      ent.hpMax = newMax;
      if (ent.hp > 0) ent.hp = Math.min(newMax, ent.hp + gain);
    } else if (c.hp > 0) {
      c.hp = Math.min(newMax, c.hp + gain);
    }
    const scorePoint = RULES.scoreIncreaseLevels.includes(c.level);
    const pending = (s.pendingLevelUps[charId] ??= { scorePoints: 0, abilityPicks: 0 });
    pending.abilityPicks += 1;
    if (scorePoint) pending.scorePoints += 1;
    emit(m, { type: "level_up", characterId: charId, name: c.name, level: c.level, hpMax: newMax, scorePoint });
  }
}

/** Spend a pending +1 ability score (levels 3, 6, 9; maximum 20). */
export function applyScoreIncrease(state: GameState, charId: string, key: AbilityScoreKey):
  { ok: boolean; state: GameState; events: EngineEvent[]; error?: string } {
  const s = cloneState(state);
  const c = s.characters[charId];
  const p = s.pendingLevelUps[charId];
  const fail = (error: string) => ({ ok: false, state, events: [] as EngineEvent[], error });
  if (!c) return fail("unknown character");
  if (!p || p.scorePoints <= 0) return fail("no ability score point is pending");
  if (c.scores[key] >= RULES.scores.max) return fail(`${key} is already ${RULES.scores.max}`);
  c.scores[key] += 1;
  p.scorePoints -= 1;
  if (key === "con") {
    const newMax = computeHpMax(c.level, c.scores.con);
    const gain = newMax - c.hp_max;
    c.hp_max = newMax;
    const ent = s.entities[charId];
    if (ent) { ent.hpMax = newMax; if (ent.hp > 0) ent.hp += gain; }
  }
  const r = finish({ s, rng: fromState(s.rngState), ev: [] }, undefined);
  return { ok: true, state: r.state, events: r.events };
}
