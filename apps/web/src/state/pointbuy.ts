import { ABILITIES } from "@aedm/schemas";

/**
 * Point-buy table for the creator UI (docs/rules-numbers.md, "Point buy"). The engine re-checks the
 * cost on claim_character; this copy only drives the live counter.
 */
export const POINT_BUY_BUDGET = 27;
export const SCORE_MIN = 8;
export const SCORE_MAX = 15;
export const SCORE_COST: Readonly<Record<number, number>> = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };

export type Scores = Record<(typeof ABILITIES)[number], number>;

export function baseScores(): Scores {
  return { str: SCORE_MIN, dex: SCORE_MIN, con: SCORE_MIN, int: SCORE_MIN, wis: SCORE_MIN, cha: SCORE_MIN };
}

export function scoreCost(score: number): number {
  const c = SCORE_COST[score];
  if (c === undefined) throw new Error(`score out of range: ${score}`);
  return c;
}

export function pointsSpent(scores: Scores): number {
  return ABILITIES.reduce((sum, k) => sum + scoreCost(scores[k]), 0);
}

export function pointsLeft(scores: Scores): number {
  return POINT_BUY_BUDGET - pointsSpent(scores);
}

/** Cost of raising `score` by one, or null when already at the maximum. */
export function nextCost(score: number): number | null {
  return score >= SCORE_MAX ? null : scoreCost(score + 1) - scoreCost(score);
}

export function canIncrease(scores: Scores, key: keyof Scores): boolean {
  const c = nextCost(scores[key]);
  return c !== null && c <= pointsLeft(scores);
}

export function canDecrease(scores: Scores, key: keyof Scores): boolean {
  return scores[key] > SCORE_MIN;
}

/** Returns a new scores object with the change applied, or the same object if not allowed. */
export function adjust(scores: Scores, key: keyof Scores, delta: 1 | -1): Scores {
  if (delta === 1 ? !canIncrease(scores, key) : !canDecrease(scores, key)) return scores;
  return { ...scores, [key]: scores[key] + delta };
}
