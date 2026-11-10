import { parseDice, type Advantage } from "@aedm/schemas";
import { RULES } from "./data.ts";
import type { Rng } from "./rng.ts";

export function rollDice(rng: Rng, count: number, sides: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(rng.int(1, sides));
  return out;
}

/** Average of NdM in hundredths: N * (M + 1) / 2 * 100. Always an integer. */
export function averageHundredths(dice: string): number {
  const { count, sides } = parseDice(dice);
  return count * (sides + 1) * 50;
}

/** Roll NdM. A crit multiplies the number of dice (not the modifier). */
export function rollDamage(rng: Rng, dice: string, opts: { crit?: boolean } = {}): { dice: number[]; total: number } {
  const { count, sides } = parseDice(dice);
  const n = opts.crit ? count * RULES.attack.critDiceMultiplier : count;
  const rolled = rollDice(rng, n, sides);
  return { dice: rolled, total: rolled.reduce((a, b) => a + b, 0) };
}

/** Roll "NdM", "NdM+K" or "NdM-K". */
export function rollNotation(rng: Rng, notation: string, opts: { crit?: boolean } = {}): { dice: number[]; modifier: number; total: number } {
  const m = /^(\d+d\d+)([+-]\d+)?$/.exec(notation.trim());
  if (!m) throw new Error(`invalid dice notation: ${notation}`);
  const modifier = m[2] ? Number(m[2]) : 0;
  const r = rollDamage(rng, m[1] as string, opts);
  return { dice: r.dice, modifier, total: r.total + modifier };
}

/** Any mix of advantage and disadvantage cancels to a normal roll. */
export function combineAdvantage(sources: readonly Advantage[]): Advantage {
  const adv = sources.some((s) => s === "advantage");
  const dis = sources.some((s) => s === "disadvantage");
  if (adv && dis) return "none";
  return adv ? "advantage" : dis ? "disadvantage" : "none";
}

export interface D20Roll { dice: number[]; kept: number; advantage: Advantage }

export function rollD20(rng: Rng, advantage: Advantage = "none"): D20Roll {
  const sides = RULES.checks.diceSides;
  if (advantage === "none") {
    const v = rng.int(1, sides);
    return { dice: [v], kept: v, advantage };
  }
  const a = rng.int(1, sides);
  const b = rng.int(1, sides);
  return { dice: [a, b], kept: advantage === "advantage" ? Math.max(a, b) : Math.min(a, b), advantage };
}
