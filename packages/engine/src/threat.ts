import { parseDice, type Ability, type Difficulty, type Enemy, type EnemyDraft, type EnemyRole } from "@aedm/schemas";
import { averageHundredths } from "./dice.ts";
import { ENEMY_DATA } from "./data.ts";
import { abilityCost, clampAbilityToLevel, validateAbilityForLevel } from "./cost.ts";
import { clampLevel } from "./rules.ts";

export interface StandardEnemy { hp: number; defense: number; attack: number; damage: number; damageHundredths: number }

/** The standard-enemy row for a level, interpolated linearly between table rows. */
export function standardEnemy(level: number): StandardEnemy {
  const L = clampLevel(level);
  const t = ENEMY_DATA.table;
  let lo = t[0]!;
  let hi = t[t.length - 1]!;
  for (let i = 0; i < t.length; i++) {
    if (t[i]!.level <= L) lo = t[i]!;
    if (t[i]!.level >= L) { hi = t[i]!; break; }
  }
  const f = hi.level === lo.level ? 0 : (L - lo.level) / (hi.level - lo.level);
  const lerp = (a: number, b: number) => a + (b - a) * f;
  const damageHundredths = Math.round(lerp(lo.damage, hi.damage) * 100);
  return {
    hp: Math.round(lerp(lo.hp, hi.hp)),
    defense: Math.round(lerp(lo.defense, hi.defense)),
    attack: Math.round(lerp(lo.attack, hi.attack)),
    damage: damageHundredths / 100,
    damageHundredths,
  };
}

/**
 * Threat = HP/4 + 2 x (Defense - 10) + 1.5 x damage per round + 0.5 x (sum of ability costs) + (speed - 6),
 * computed in hundredths and returned as a number.
 */
export function threatFromStats(s: { hp: number; defense: number; damagePerRound: number; speed: number; abilityCosts: readonly number[] }): number {
  const T = ENEMY_DATA.threat;
  const dprH = Math.round(s.damagePerRound * 100);
  const total =
    s.hp * T.hpHundredthsPerHp +
    (s.defense - T.defenseBase) * T.defenseHundredths +
    Math.round((dprH * T.damageHundredthsMult) / 100) +
    s.abilityCosts.reduce((a, b) => a + b, 0) * T.abilityCostHundredths +
    (s.speed - T.speedBase) * T.speedHundredths;
  return total / 100;
}

type EnemyLike = Pick<Enemy, "role" | "stats" | "abilities"> | Pick<EnemyDraft, "role" | "stats" | "abilities">;

/** Average damage of the enemy's best repeatable action (basic attack, or a cooldown-0 damaging ability), in hundredths. */
export function enemyDamagePerRoundHundredths(e: EnemyLike): number {
  let best = averageHundredths(e.stats.damage_dice);
  for (const a of e.abilities) {
    if (a.cooldown_turns !== 0) continue;
    let sum = 0;
    for (const fx of a.effects) if (fx.type === "damage") sum += averageHundredths(fx.dice);
    best = Math.max(best, sum);
  }
  return best;
}

export function enemyThreat(e: EnemyLike): number {
  return threatFromStats({
    hp: e.stats.hp,
    defense: e.stats.defense,
    damagePerRound: enemyDamagePerRoundHundredths(e) / 100,
    speed: e.stats.speed,
    abilityCosts: e.abilities.map((a) => abilityCost(a as Ability)),
  });
}

export interface Range { min: number; max: number }
export interface EnemyRanges {
  hp: Range; defense: Range; attack: Range; damageHundredths: Range; speed: Range; abilities: Range;
}

export function enemyRangesForLevel(level: number, role: EnemyRole): EnemyRanges {
  const base = standardEnemy(level);
  const r = ENEMY_DATA.roles[role];
  const tol = ENEMY_DATA.tolerance;
  const scale = (v: number, rolePct: number, tolPct: number): Range => ({
    min: Math.max(1, Math.ceil((v * rolePct * (100 - tolPct)) / 10000)),
    max: Math.floor((v * rolePct * (100 + tolPct)) / 10000),
  });
  return {
    hp: scale(base.hp, r.hpPct, tol.hpPct),
    defense: { min: base.defense - tol.defense, max: base.defense + tol.defense },
    attack: { min: base.attack - tol.attack, max: base.attack + tol.attack },
    damageHundredths: scale(base.damageHundredths, r.damagePct, tol.damagePct),
    speed: { ...ENEMY_DATA.speedRange },
    abilities: { min: r.abilitiesMin, max: r.abilitiesMax },
  };
}

export function encounterBudget(partySize: number, partyLevel: number, difficulty: Difficulty, opts: { boss?: boolean } = {}): number {
  const B = ENEMY_DATA.budget;
  const standard = partySize * (B.perCharacterBase + B.perLevel * clampLevel(partyLevel));
  const pct = ENEMY_DATA.difficultyPct[difficulty] * (opts.boss ? B.bossMultiplierPct : 100);
  return (standard * pct) / 10000;
}

/** One boss may spend up to 1.5x the standard (difficulty-independent) budget alone. */
export function bossThreatCap(partySize: number, partyLevel: number): number {
  return encounterBudget(partySize, partyLevel, "standard", { boss: true });
}

const inRange = (v: number, r: Range) => v >= r.min && v <= r.max;

export function validateEnemy(e: Enemy | EnemyDraft, partyLevel: number): { ok: boolean; errors: string[] } {
  const rg = enemyRangesForLevel(partyLevel, e.role);
  const errors: string[] = [];
  const s = e.stats;
  if (!inRange(s.hp, rg.hp)) errors.push(`hp ${s.hp} outside ${rg.hp.min}-${rg.hp.max} for a ${e.role} at level ${clampLevel(partyLevel)}`);
  if (!inRange(s.defense, rg.defense)) errors.push(`defense ${s.defense} outside ${rg.defense.min}-${rg.defense.max}`);
  if (!inRange(s.attack_bonus, rg.attack)) errors.push(`attack bonus ${s.attack_bonus} outside ${rg.attack.min}-${rg.attack.max}`);
  if (!inRange(s.speed, rg.speed)) errors.push(`speed ${s.speed} outside ${rg.speed.min}-${rg.speed.max}`);
  const dpr = enemyDamagePerRoundHundredths(e);
  if (!inRange(dpr, rg.damageHundredths)) {
    errors.push(`damage per round ${dpr / 100} outside ${rg.damageHundredths.min / 100}-${rg.damageHundredths.max / 100}`);
  }
  if (!inRange(e.abilities.length, rg.abilities)) {
    errors.push(`${e.role} needs ${rg.abilities.min} to ${rg.abilities.max} abilities, has ${e.abilities.length}`);
  }
  e.abilities.forEach((a, i) => {
    for (const msg of validateAbilityForLevel(a as Ability, partyLevel).errors) errors.push(`ability ${i + 1}: ${msg}`);
  });
  return { ok: errors.length === 0, errors };
}

const SIDES = [4, 6, 8, 10, 12];

function bestDice(current: string, range: Range): string {
  const cur = parseDice(current);
  const curAvg = averageHundredths(current);
  const target = Math.min(range.max, Math.max(range.min, curAvg));
  let best = current;
  let bestScore = Infinity;
  for (let n = 1; n <= 8; n++) {
    for (const m of SIDES) {
      const d = `${n}d${m}`;
      const avg = averageHundredths(d);
      const off = inRange(avg, range) ? 0 : 1000000 + Math.abs(avg - target);
      const score = off + Math.abs(avg - target) * 10 + Math.abs(n - cur.count) * 3 + Math.abs(m - cur.sides);
      if (score < bestScore) { bestScore = score; best = d; }
    }
  }
  return best;
}

const clampTo = (v: number, r: Range) => Math.min(r.max, Math.max(r.min, v));

/** Scale a draft into the allowed ranges for the party level. The result has a recomputed `threat`. */
export function clampEnemy(draft: Enemy | EnemyDraft, partyLevel: number): { enemy: Enemy; notes: string[] } {
  const notes: string[] = [];
  const src = structuredClone(draft) as EnemyDraft;
  let role = src.role;
  let rg = enemyRangesForLevel(partyLevel, role);

  const abilities: Ability[] = [];
  for (const a of src.abilities) {
    const r = clampAbilityToLevel(a, partyLevel);
    for (const n of r.notes) notes.push(`${a.name}: ${n}`);
    abilities.push(r.ability);
  }
  if (abilities.length > rg.abilities.max) {
    notes.push(`abilities cut from ${abilities.length} to ${rg.abilities.max} for a ${role}`);
    abilities.length = rg.abilities.max;
  }
  if (abilities.length < rg.abilities.min) {
    const fallback: EnemyRole = role === "boss" ? "elite" : "standard";
    notes.push(`${role} needs at least ${rg.abilities.min} abilities; role changed to ${fallback}`);
    role = fallback;
    rg = enemyRangesForLevel(partyLevel, role);
    if (abilities.length < rg.abilities.min) { role = "standard"; rg = enemyRangesForLevel(partyLevel, role); }
  }

  const stats = { ...src.stats };
  const fix = (name: string, v: number, r: Range): number => {
    const c = clampTo(v, r);
    if (c !== v) notes.push(`${name} changed from ${v} to ${c}`);
    return c;
  };
  stats.hp = fix("hp", stats.hp, rg.hp);
  stats.defense = fix("defense", stats.defense, rg.defense);
  stats.attack_bonus = fix("attack bonus", stats.attack_bonus, rg.attack);
  stats.speed = fix("speed", stats.speed, rg.speed);

  const probe = { role, stats, abilities };
  if (!inRange(enemyDamagePerRoundHundredths(probe), rg.damageHundredths)) {
    const from = stats.damage_dice;
    stats.damage_dice = bestDice(stats.damage_dice, rg.damageHundredths);
    if (stats.damage_dice !== from) notes.push(`damage dice changed from ${from} to ${stats.damage_dice}`);
  }
  // Repeatable damaging abilities can still push damage per round over the top.
  let guard = 0;
  while (enemyDamagePerRoundHundredths({ role, stats, abilities }) > rg.damageHundredths.max && guard++ < 20) {
    const a = abilities.find((x) => x.cooldown_turns === 0 && x.effects.some((f) => f.type === "damage"));
    if (!a) break;
    a.cooldown_turns = 1;
    notes.push(`${a.name}: cooldown set to 1 to keep damage per round in range`);
    a.cost = abilityCost(a);
  }

  const enemy: Enemy = {
    v: 1,
    name: src.name,
    concept: src.concept,
    role,
    stats,
    weakness: src.weakness,
    resistance: src.resistance,
    behavior: src.behavior,
    loot_hint: src.loot_hint ?? "",
    sprite_tags: src.sprite_tags ?? [],
    abilities,
  };
  if (typeof src.appearance === "string" && src.appearance.trim()) enemy.appearance = src.appearance.trim().slice(0, 160);
  if ((src as { sprite?: Enemy["sprite"] }).sprite) enemy.sprite = (src as { sprite?: Enemy["sprite"] }).sprite;
  if (typeof src.id === "string" && /^en_[A-Za-z0-9_-]{1,60}$/.test(src.id)) enemy.id = src.id;
  enemy.threat = enemyThreat(enemy);
  return { enemy, notes };
}
