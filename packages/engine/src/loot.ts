/** Loot tables: pure rolls from `data/loot.json`. No state, no I/O; the caller passes the seeded rng. */
import type { Item } from "@aedm/schemas";
import { LOOT, RULES, type LootTemplate } from "./data.ts";
import type { Rng } from "./rng.ts";
import { levelCaps } from "./rules.ts";

export type LootKind = "consumable" | "weapon" | "armor" | "trinket";

export interface LootRollOptions {
  /** Gear tier allowance (1 to 5): gear above it and rarer non-gear items are not rolled. */
  tier: number;
  /** The most the whole roll may be worth, in gold-equivalent value. */
  budgetValue: number;
  /** Restrict to these kinds. Quest items are never rolled. */
  kinds?: readonly LootKind[];
  /** At most this many items (default `roll.maxItems` in `loot.json`). */
  maxItems?: number;
  /** Item id generator. Engine callers pass the state's counter; the default draws from the rng. */
  newId?: () => string;
}

/** The loot tier a party level rolls at: the weapon tier its level allows, so no gear is above the party's allowance. */
export function lootTierForLevel(level: number): number {
  return levelCaps(level).weaponTier;
}

const valueOf = (t: LootTemplate): number => (t.draught ? RULES.draught.value : (t.value ?? 0));
const nameOf = (t: LootTemplate): string => (t.draught ? RULES.draught.name : t.name);
const isGear = (t: LootTemplate): boolean => t.kind === "weapon" || t.kind === "armor";
const allowed = (t: LootTemplate, tier: number): boolean => (isGear(t) ? (t.tier ?? 1) <= tier : (t.minTier ?? 1) <= tier);

function weightedPick<T>(rng: Rng, entries: readonly { item: T; weight: number }[]): T {
  const sum = entries.reduce((n, e) => n + e.weight, 0);
  let r = rng.int(1, sum);
  for (const e of entries) {
    r -= e.weight;
    if (r <= 0) return e.item;
  }
  return (entries[entries.length - 1] as { item: T }).item;
}

/**
 * Roll up to `maxItems` items whose total value never exceeds `budgetValue`. For each item the kind is picked by
 * `kindWeights` among kinds that still have an affordable template, then a template by its weight. Stops early when
 * nothing affordable is left, so a tiny budget gives nothing.
 */
export function rollLoot(rng: Rng, opts: LootRollOptions): Item[] {
  const tier = Math.min(5, Math.max(1, Math.trunc(opts.tier) || 1));
  const kinds = opts.kinds ?? (Object.keys(LOOT.kindWeights) as LootKind[]);
  const cap = Math.max(0, Math.trunc(opts.maxItems ?? LOOT.roll.maxItems));
  const make = opts.newId ?? (() => `it_${rng.int(0, 0xffffff).toString(36)}`);
  const pool = LOOT.templates.filter((t) => (kinds as readonly string[]).includes(t.kind) && allowed(t, tier));
  let remaining = Math.max(0, Math.trunc(opts.budgetValue));
  const count = cap === 0 ? 0 : rng.int(Math.min(LOOT.roll.minItems, cap), cap);
  const out: Item[] = [];
  const taken = new Set<string>();
  for (let i = 0; i < count; i++) {
    const affordable = pool.filter((t) => valueOf(t) <= remaining && valueOf(t) > 0);
    const kindEntries = [...new Set(affordable.map((t) => t.kind))].map((k) => ({ item: k, weight: LOOT.kindWeights[k] ?? 0 })).filter((e) => e.weight > 0);
    if (kindEntries.length === 0) break;
    const kind = weightedPick(rng, kindEntries);
    const t = weightedPick(rng, affordable.filter((x) => x.kind === kind).map((x) => ({ item: x, weight: x.weight })));
    let id = make();
    while (taken.has(id)) id = make();
    taken.add(id);
    const value = valueOf(t);
    remaining -= value;
    out.push({ id, name: nameOf(t), kind: t.kind, value, ...(isGear(t) ? { tier: t.tier ?? 1 } : {}) });
  }
  return out;
}
