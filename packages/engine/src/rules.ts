import { ABILITIES, type AbilityScores, type AbilityScoreKey, type Condition } from "@aedm/schemas";
import { LEVELS, RULES, type ArmorInfo, type LevelRow } from "./data.ts";

export type ConditionLike = Condition | { condition: Condition };
const condName = (c: ConditionLike): Condition => (typeof c === "string" ? c : c.condition);

export function abilityModifier(score: number): number {
  return Math.floor((score - RULES.abilityModifier.base) / RULES.abilityModifier.divisor);
}

export function clampLevel(level: number): number {
  return Math.min(RULES.levelCap, Math.max(1, Math.trunc(level) || 1));
}

export function levelRow(level: number): LevelRow {
  return LEVELS[clampLevel(level) - 1] as LevelRow;
}

export function proficiency(level: number): number {
  return levelRow(level).proficiency;
}

export interface LevelCaps {
  level: number;
  proficiency: number;
  budget: number;
  perAbilityCap: number;
  maxAverage: number;
  maxRadius: number;
  maxConditionTurns: number;
  maxStunTurns: number;
  weaponTier: number;
}

export function levelCaps(level: number): LevelCaps {
  const r = levelRow(level);
  return {
    level: r.level, proficiency: r.proficiency, budget: r.budget, perAbilityCap: r.perAbilityCap,
    maxAverage: r.maxAverage, maxRadius: r.maxRadius, maxConditionTurns: r.maxConditionTurns,
    maxStunTurns: r.maxStunTurns, weaponTier: r.weaponTier,
  };
}

/** Loot cap per encounter in gold-equivalent value: 20 + 10 x level. */
export function lootCap(level: number): number {
  return RULES.loot.base + RULES.loot.perLevel * clampLevel(level);
}

export function weaponDice(tier: number): string {
  const t = Math.min(5, Math.max(1, Math.trunc(tier) || 1));
  return RULES.weaponTiers[String(t)] as string;
}

export function armorInfo(armorBonus: number): ArmorInfo {
  const exact = RULES.armor[String(armorBonus)];
  if (exact) return exact;
  const keys = Object.keys(RULES.armor).map(Number).sort((a, b) => a - b);
  let best = keys[0] as number;
  for (const k of keys) if (k <= armorBonus) best = k;
  return RULES.armor[String(best)] as ArmorInfo;
}

/** Defense = 10 + DEX modifier (capped by armor) + armor bonus, adjusted by slowed (-1) and hasted (+2). */
export function defense(scores: Pick<AbilityScores, "dex">, armorBonus: number, conditions: readonly ConditionLike[] = []): number {
  const info = armorInfo(armorBonus);
  let dex = abilityModifier(scores.dex);
  if (info.dexCap !== null) dex = Math.min(dex, info.dexCap);
  let d = RULES.defense.base + dex + armorBonus;
  const names = conditions.map(condName);
  if (names.includes("slowed")) d += -1;
  if (names.includes("hasted")) d += 2;
  return d;
}

/** Speed in tiles: 6 base, hasted +2, slowed -2 (min 1), heavy armor -1, rooted 0. */
export function speed(opts: { conditions?: readonly ConditionLike[]; armorBonus?: number; baseSpeed?: number }): number {
  const names = (opts.conditions ?? []).map(condName);
  if (names.includes("rooted")) return 0;
  let s = opts.baseSpeed ?? RULES.speed.base;
  s -= armorInfo(opts.armorBonus ?? 0).speedPenalty;
  if (names.includes("hasted")) s += RULES.speed.hasted;
  if (names.includes("slowed")) s += RULES.speed.slowed;
  return Math.max(RULES.speed.min, s);
}

export function initiativeBonus(dexScore: number): number {
  return abilityModifier(dexScore);
}

export function pointBuyCost(score: number): number {
  const c = RULES.pointBuy.costs[String(score)];
  if (c === undefined) throw new Error(`score ${score} is outside the point-buy table`);
  return c;
}

export function validatePointBuy(scores: Record<string, number>): { ok: boolean; total: number; errors: string[] } {
  const errors: string[] = [];
  let total = 0;
  for (const k of ABILITIES) {
    const v = scores[k];
    if (typeof v !== "number" || !Number.isInteger(v)) {
      errors.push(`${k} is missing or not an integer`);
      continue;
    }
    if (v < RULES.scores.creationMin || v > RULES.scores.creationMax) {
      errors.push(`${k} ${v} must be ${RULES.scores.creationMin} to ${RULES.scores.creationMax} at creation`);
      continue;
    }
    total += pointBuyCost(v);
  }
  if (errors.length === 0 && total !== RULES.pointBuy.budget) {
    errors.push(`scores cost ${total} points, must cost exactly ${RULES.pointBuy.budget}`);
  }
  return { ok: errors.length === 0, total, errors };
}

/** HP at level 1 is 10 + CON modifier; each later level adds 6 + CON modifier (at least 1). */
export function hpMax(level: number, conScore: number): number {
  const con = abilityModifier(conScore);
  const L = clampLevel(level);
  const perLevel = Math.max(RULES.hp.perLevelMin, RULES.hp.perLevelBase + con);
  return Math.max(1, RULES.hp.level1Base + con + (L - 1) * perLevel);
}

export function levelFromGrowth(growth: number): number {
  return clampLevel(1 + Math.floor(Math.max(0, growth) / RULES.growth.perLevel));
}

export function growthToNextLevel(growth: number): number {
  const g = Math.max(0, growth);
  return RULES.growth.perLevel - (g % RULES.growth.perLevel);
}

export function keyAbilityModifier(scores: AbilityScores, key: AbilityScoreKey): number {
  return abilityModifier(scores[key]);
}

/** Save DC = 8 + proficiency + key ability modifier. */
export function saveDc(level: number, keyScore: number): number {
  return RULES.saveDcBase + proficiency(level) + abilityModifier(keyScore);
}
