/**
 * Ability cost, all in integer hundredths.
 *
 * Order of integer operations (documented because the fixtures depend on it):
 *   1. price each effect in whole cost points, times 100, times its own duration multiplier / 100
 *      (a per-effect price is `base * durationMultiplierHundredths`, already in hundredths);
 *   2. sum the effect prices (hundredths);
 *   3. multiply the sum by the four multipliers (area, save, range, frequency), each in hundredths,
 *      WITHOUT intermediate rounding: product = sum * a * s * r * f;
 *   4. divide by 100^4 once, rounding to the nearest hundredth (half up) -> `abilityCostHundredths`;
 *   5. the cost is that value divided by 100, rounded up, minimum 1.
 * The largest intermediate product stays below 2^53, so plain numbers are exact.
 */
import {
  parseDice, type Ability, type AbilityDraft, type Effect, type Condition, type DamageEffect, type HealEffect,
  type TerrainEffect,
} from "@aedm/schemas";
import { averageHundredths } from "./dice.ts";
import { COSTS, RULES } from "./data.ts";
import { levelCaps } from "./rules.ts";

export type CostableAbility = Pick<Ability, "range_tiles" | "effects" | "cooldown_turns" | "uses_per_rest">;

const U = COSTS.unit;
const ceilDiv = (a: number, b: number) => Math.floor((a + b - 1) / b);

function durationMult(turns: number): number {
  const key = String(Math.min(3, Math.max(1, turns)));
  return COSTS.durationMultipliers[key] as number;
}

/** ceil(average / 2) in whole points. */
function diceHalfPrice(dice: string, divisor: number): number {
  return ceilDiv(averageHundredths(dice), U * divisor);
}

function damagePrice(dice: string): number {
  return diceHalfPrice(dice, COSTS.damagePriceDivisor);
}

/** Price of one effect, in hundredths. */
export function effectPriceHundredths(e: Effect): number {
  switch (e.type) {
    case "damage": return damagePrice(e.dice) * U;
    case "heal": return diceHalfPrice(e.dice, COSTS.healPriceDivisor) * U;
    case "shield": return ceilDiv(e.absorb, COSTS.shieldDivisor) * durationMult(e.duration_turns);
    case "condition": {
      const per = COSTS.conditionPerTurn[e.condition as Condition];
      if (per === undefined) throw new Error(`no price for condition ${e.condition}`);
      return per * durationMult(e.duration_turns);
    }
    case "mark": return COSTS.markPricePerTurn * durationMult(e.duration_turns);
    case "push":
    case "pull": return ceilDiv(e.tiles, COSTS.pushPullDivisor) * U;
    case "dash": return ceilDiv(e.tiles, COSTS.dashDivisor) * U;
    case "teleport": return Math.min(e.tiles, COSTS.teleportMaxTiles) * COSTS.teleportPerTile * U;
    case "reveal": return COSTS.revealPrice * U;
    case "disarm": return COSTS.disarmPrice * U;
    case "terrain": {
      const base = (COSTS.terrain[e.kind] as number) + (e.dice ? damagePrice(e.dice) : 0);
      if (COSTS.terrainTimed.includes(e.kind)) return base * durationMult(e.duration_turns ?? 1);
      return base * U; // traps last until triggered
    }
    case "check_bonus": {
      const base = e.bonus <= COSTS.checkBonus.lowMaxBonus ? COSTS.checkBonus.low : COSTS.checkBonus.high;
      return base * durationMult(e.duration_turns);
    }
  }
}

function effectAreaMult(e: Effect): number {
  const burst = (r: number | undefined) => ((r ?? 1) >= 2 ? COSTS.area.burst2 : COSTS.area.burst1);
  switch (e.type) {
    case "damage":
    case "heal":
    case "terrain":
      if (e.shape === "burst") return burst(e.radius_tiles);
      if (e.shape === "line") return COSTS.area.line;
      if (e.shape === "cone") return COSTS.area.cone;
      return COSTS.area.single;
    case "reveal": return burst(e.radius_tiles);
    default: return COSTS.area.single;
  }
}

function effectHasSave(e: Effect): boolean {
  return (e.type === "damage" || e.type === "condition") && e.save !== undefined;
}

export function rangeMultiplier(rangeTiles: number): number {
  for (const r of COSTS.range) if (rangeTiles <= r.maxTiles) return r.mult;
  return (COSTS.range[COSTS.range.length - 1] as { mult: number }).mult;
}

export function frequencyMultiplier(a: Pick<Ability, "cooldown_turns" | "uses_per_rest">): number {
  if (a.uses_per_rest !== undefined) {
    const u = COSTS.uses[String(Math.min(3, Math.max(1, a.uses_per_rest)))];
    return u as number;
  }
  const cd = Math.max(0, a.cooldown_turns ?? 0);
  return COSTS.cooldown[String(Math.min(cd, COSTS.cooldownMaxKey))] as number;
}

/** Ability cost in hundredths (see the module comment for the exact rounding). */
export function abilityCostHundredths(a: CostableAbility): number {
  const sum = a.effects.reduce((s, e) => s + effectPriceHundredths(e), 0);
  const area = Math.max(...a.effects.map(effectAreaMult));
  const save = a.effects.some(effectHasSave) ? COSTS.save.save : COSTS.save.none;
  const range = rangeMultiplier(a.range_tiles);
  const freq = frequencyMultiplier(a);
  const num = sum * area * save * range * freq;
  const den = U * U * U * U;
  return Math.floor((num + den / 2) / den);
}

export function abilityCost(a: CostableAbility): number {
  return Math.max(COSTS.minCost, ceilDiv(abilityCostHundredths(a), U));
}

// ---------- level validation ----------

function diceAverage(dice: string): number {
  return averageHundredths(dice) / U;
}

/**
 * Divergence from rules-numbers.md, forced by its own fixtures: the radius cap applies to damage, heal
 * and terrain areas only. Fog Lantern (reveal radius 2) is a level-1 worked example, so reveal radius is
 * priced by the area multiplier but not capped.
 */
export function validateAbilityForLevel(a: CostableAbility, level: number): { ok: boolean; errors: string[] } {
  const caps = levelCaps(level);
  const errors: string[] = [];
  if (a.range_tiles > RULES.abilityLimits.maxRange) errors.push(`range ${a.range_tiles} exceeds ${RULES.abilityLimits.maxRange}`);
  const capped = RULES.abilityDurationCap.conditions;
  a.effects.forEach((e, i) => {
    const at = `effect ${i + 1} (${e.type})`;
    if ((e.type === "damage" || e.type === "heal" || (e.type === "terrain" && e.dice)) && "dice" in e && e.dice) {
      if (averageHundredths(e.dice) > caps.maxAverage * U) {
        errors.push(`${at}: average ${diceAverage(e.dice)} exceeds the level ${caps.level} maximum average of ${caps.maxAverage}`);
      }
    }
    if ((e.type === "damage" || e.type === "heal" || e.type === "terrain") && e.radius_tiles !== undefined && e.radius_tiles > caps.maxRadius) {
      errors.push(`${at}: radius ${e.radius_tiles} exceeds the level ${caps.level} maximum radius of ${caps.maxRadius}`);
    }
    if (e.type === "condition") {
      if (e.condition === "stunned" && e.duration_turns > caps.maxStunTurns) {
        errors.push(`${at}: stun ${e.duration_turns} turns exceeds the level ${caps.level} stun cap of ${caps.maxStunTurns}`);
      } else if (e.condition !== "stunned" && capped.includes(e.condition) && e.duration_turns > caps.maxConditionTurns) {
        errors.push(`${at}: ${e.condition} ${e.duration_turns} turns exceeds the condition cap of ${caps.maxConditionTurns}`);
      }
    }
  });
  const cost = abilityCost(a);
  if (cost > caps.perAbilityCap) errors.push(`cost ${cost} exceeds the per-ability cap of ${caps.perAbilityCap} at level ${caps.level}`);
  return { ok: errors.length === 0, errors };
}

export function validateCharacterAbilities(
  abilities: readonly CostableAbility[],
  level: number,
): { ok: boolean; errors: string[]; total: number } {
  const caps = levelCaps(level);
  const errors: string[] = [];
  if (abilities.length < 1 || abilities.length > RULES.abilityLimits.maxAbilitiesPerCharacter) {
    errors.push(`a character needs 1 to ${RULES.abilityLimits.maxAbilitiesPerCharacter} abilities, got ${abilities.length}`);
  }
  let total = 0;
  abilities.forEach((a, i) => {
    total += abilityCost(a);
    const r = validateAbilityForLevel(a, level);
    for (const e of r.errors) errors.push(`ability ${i + 1}: ${e}`);
  });
  if (total > caps.budget) errors.push(`abilities total ${total}, over the level ${caps.level} power budget of ${caps.budget}`);
  return { ok: errors.length === 0, errors, total };
}

// ---------- clamping ----------

const SIDES = [4, 6, 8, 10, 12];

/** One step smaller: drop a die, or step the die size down when only one die is left. Null at 1d4. */
function stepDiceDown(dice: string): string | null {
  const { count, sides } = parseDice(dice);
  if (count > 1) return `${count - 1}d${sides}`;
  const i = SIDES.indexOf(sides);
  return i > 0 ? `1d${SIDES[i - 1]}` : null;
}

type MutableEffect = Effect & Record<string, unknown>;

function clampDiceTo(dice: string, maxAvgHundredths: number): string {
  let d = dice;
  while (averageHundredths(d) > maxAvgHundredths) {
    const n = stepDiceDown(d);
    if (n === null) break;
    d = n;
  }
  return d;
}

/**
 * Scale an over-cap draft down to a level (and, with `maxCost`, to the power budget the player has left). Order: range, dice, radius, durations (stun, then capped
 * conditions), then price: shorten durations, shrink radius, shrink dice, switch to 1 use per rest,
 * and finally drop trailing effects. The result always carries a recomputed `cost`.
 */
export function clampAbilityToLevel(
  draft: Ability | AbilityDraft, level: number, opts: { maxCost?: number } = {},
): { ability: Ability; notes: string[] } {
  const caps = levelCaps(level);
  const costCap = Math.min(caps.perAbilityCap, opts.maxCost ?? Number.POSITIVE_INFINITY);
  const notes: string[] = [];
  const src = structuredClone(draft) as AbilityDraft;
  const effects = src.effects as MutableEffect[];
  const note = (s: string) => notes.push(s);

  if (src.range_tiles > RULES.abilityLimits.maxRange) {
    note(`range reduced from ${src.range_tiles} to ${RULES.abilityLimits.maxRange}`);
    src.range_tiles = RULES.abilityLimits.maxRange;
  }

  const fixShape = (e: MutableEffect) => {
    if ((e.type === "damage" || e.type === "heal" || e.type === "terrain") && "dice" in e && e.dice) {
      const dice = e.dice as string;
      const next = clampDiceTo(dice, caps.maxAverage * U);
      if (next !== dice) {
        note(`${e.type} dice reduced from ${dice} to ${next}`);
        (e as { dice: string }).dice = next;
      }
    }
    if ((e.type === "damage" || e.type === "heal" || e.type === "terrain") && typeof e.radius_tiles === "number" && e.radius_tiles > caps.maxRadius) {
      note(`${e.type} radius reduced from ${e.radius_tiles} to ${caps.maxRadius}`);
      e.radius_tiles = caps.maxRadius;
    }
    if (e.type === "condition") {
      const cap = e.condition === "stunned" ? caps.maxStunTurns
        : RULES.abilityDurationCap.conditions.includes(e.condition) ? caps.maxConditionTurns : 3;
      if (e.duration_turns > cap) {
        note(`${e.condition} reduced from ${e.duration_turns} to ${cap} turn(s)`);
        e.duration_turns = cap;
      }
    }
  };
  effects.forEach(fixShape);

  const cost = () => abilityCost(src as unknown as CostableAbility);
  const over = () => cost() > costCap;

  if (over()) {
    // 1. shorten the longest duration
    let guard = 0;
    while (over() && guard++ < 20) {
      let best: MutableEffect | null = null;
      for (const e of effects) {
        if ((e.type === "condition" || e.type === "shield" || e.type === "mark" || e.type === "check_bonus" || (e.type === "terrain" && e.kind !== "trap"))
          && typeof e.duration_turns === "number" && e.duration_turns > 1 && (best === null || e.duration_turns > (best.duration_turns as number))) best = e;
      }
      if (!best) break;
      (best.duration_turns as number) -= 1;
      note(`${best.type} duration reduced to ${best.duration_turns} turn(s) to fit your power budget`);
    }
    // 2. shrink radius
    for (const e of effects) {
      if (!over()) break;
      if (typeof e.radius_tiles === "number" && e.radius_tiles > 1) {
        e.radius_tiles = 1;
        note(`${e.type} radius reduced to 1 to fit your power budget`);
      }
    }
    // 3. shrink dice, biggest first
    guard = 0;
    while (over() && guard++ < 40) {
      let best: MutableEffect | null = null;
      for (const e of effects) {
        if ("dice" in e && typeof e.dice === "string" && stepDiceDown(e.dice) !== null
          && (best === null || averageHundredths(e.dice) > averageHundredths(best.dice as string))) best = e;
      }
      if (!best) break;
      const to = stepDiceDown(best.dice as string) as string;
      note(`${best.type} dice reduced from ${best.dice as string} to ${to} to fit your power budget`);
      best.dice = to;
    }
    // 4. limited uses
    if (over() && !(src.uses_per_rest === 1 && src.cooldown_turns === undefined)) {
      delete src.cooldown_turns;
      src.uses_per_rest = 1;
      note("changed to 1 use per rest to fit your power budget");
    }
    // 5. drop trailing effects
    while (over() && effects.length > 1) {
      const dropped = effects.pop() as MutableEffect;
      note(`removed ${dropped.type} effect to fit your power budget`);
    }
  }

  const { id, cost: _ignored, ...rest } = src as AbilityDraft & { cost?: unknown };
  const ability = { ...rest, v: 1, tags: src.tags ?? [] } as unknown as Ability;
  if (typeof id === "string" && /^ab_[A-Za-z0-9_-]{1,60}$/.test(id)) ability.id = id;
  if (notes.length > 0) {
    ability.forge_notes = [ability.forge_notes, `Engine adjusted: ${notes.join("; ")}.`].filter(Boolean).join(" ").slice(0, 200);
  }
  ability.cost = abilityCost(ability);
  return { ability, notes };
}

export type { DamageEffect, HealEffect, TerrainEffect };
