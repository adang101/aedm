import rules from "@aedm/engine/data/rules.json";
import { modifier } from "./describe";

/** Numbers come from the engine's data files, never hardcoded here. */
const GROWTH_PER_LEVEL: number = rules.growth.perLevel;
const LEVEL_CAP: number = rules.levelCap;
const DEFENSE_BASE: number = rules.defense.base;
const ARMOR = rules.armor as Record<string, { name: string; dexCap: number | null }>;

/** Defense = base + DEX modifier (capped by armor) + armor bonus. Matches the engine without conditions. */
export function defenseOf(dex: number, armorBonus: number): number {
  const info = ARMOR[String(armorBonus)];
  let d = modifier(dex);
  if (info && info.dexCap !== null) d = Math.min(d, info.dexCap);
  return DEFENSE_BASE + d + armorBonus;
}

export function armorName(armorBonus: number): string {
  return ARMOR[String(armorBonus)]?.name ?? "none";
}

/** Growth toward the next level: points into the current level out of the per-level need. */
export function growthProgress(growth: number, level: number): { into: number; need: number; pct: number; maxed: boolean } {
  const need = GROWTH_PER_LEVEL;
  if (level >= LEVEL_CAP) return { into: need, need, pct: 100, maxed: true };
  const into = Math.max(0, growth) % need;
  return { into, need, pct: Math.round((into / need) * 100), maxed: false };
}
