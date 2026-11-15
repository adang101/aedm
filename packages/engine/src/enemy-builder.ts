/**
 * Deterministic, offline enemy builder: concept text and role in, a validated `Enemy` out. No model call.
 * All keyword tables, sentences, default names, trait shifts and kit numbers live in `data/enemy-kits.json`;
 * this file only picks and fills. Same input always gives the same enemy (the rng is seeded from `seed` mixed
 * with a hash of the concept text).
 */
import { DICE_SIDES, type Ability, type Enemy, type EnemyDraft, type EnemyRole } from "@aedm/schemas";
import { averageHundredths } from "./dice.ts";
import { ENEMY_DATA, ENEMY_KITS, RULES, type KitAbilityTemplate, type KitTheme } from "./data.ts";
import { clampAbilityToLevel } from "./cost.ts";
import { clampLevel, levelCaps } from "./rules.ts";
import { createRng, hashSeed, type Rng } from "./rng.ts";
import { clampEnemy, enemyRangesForLevel, validateEnemy, type Range } from "./threat.ts";

export interface BuildEnemyInput {
  concept: string;
  role: EnemyRole;
  settingNotes?: string | undefined;
  partyLevel: number;
  /** The DM's archetype reference, like `en_robed_chorister`. Names the enemy when present. */
  ref?: string | undefined;
  seed: number;
}

export interface BuildEnemyResult { enemy: Enemy; notes: string[] }

const K = ENEMY_KITS;
const WORD = /[\p{L}\p{N}]/u;

// ---------- text helpers ----------

function tokensOf(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

/** Keywords (single words, optional plural) found among the tokens. */
function matched(keywords: readonly string[], tokens: ReadonlySet<string>): string[] {
  return keywords.filter((k) => tokens.has(k) || tokens.has(`${k}s`) || tokens.has(`${k}es`));
}

const titleWord = (w: string): string => {
  const [first = "", ...rest] = [...w.toLowerCase()];
  return first.toUpperCase() + rest.join("");
};

function cleanConcept(concept: string, role: EnemyRole): string {
  // eslint-disable-next-line no-control-regex
  const t = concept.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, K.maxConceptLength).trim();
  return t || K.defaultConcept.replace("{role}", role);
}

/** The name an archetype ref spells: `en_robed_chorister` gives "Robed Chorister". Undefined when nothing is left. */
export function enemyNameFromRef(ref: string): string | undefined {
  const prefix = K.name.refPrefix;
  const body = ref.trim().toLowerCase().startsWith(prefix) ? ref.trim().slice(prefix.length) : ref.trim();
  const words = body.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(titleWord);
  return fitWords(words);
}

function fitWords(words: string[]): string | undefined {
  let out = "";
  for (const w of words) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > K.name.maxLength) {
      if (!out) out = w.slice(0, K.name.maxLength);
      break;
    }
    out = next;
  }
  return out.trim() || undefined;
}

/** The head of a concept: leading article dropped, cut at the first clause word or punctuation, a few words, title case. */
export function enemyNameFromConcept(concept: string, role: EnemyRole): string {
  const N = K.name;
  const words: string[] = [];
  for (const raw of concept.split(/\s+/)) {
    if (words.length >= N.maxWords) break;
    const clean = raw.toLowerCase().replace(/[^\p{L}\p{N}'-]/gu, "");
    if (!WORD.test(clean)) continue;
    if (words.length === 0 && N.articles.includes(clean)) continue;
    if (N.clauseWords.includes(clean)) break;
    words.push(titleWord(clean));
    if (/[,;:.!?()—–]$/.test(raw)) break;
  }
  while (words.length > 0 && N.trailingWords.includes((words[words.length - 1] as string).toLowerCase())) words.pop();
  return fitWords(words) ?? N.defaults[role];
}

// ---------- picks ----------

function shuffle<T>(rng: Rng, arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

const clampN = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const atPct = (r: Range, pct: number) => r.min + Math.round((clampN(pct, 0, 100) * (r.max - r.min)) / 100);

/** The dice whose average is closest to the target, preferring one inside the range, then fewer dice. */
function diceNear(targetH: number, range?: Range): string {
  let best = "1d4";
  let bestScore = Infinity;
  for (let n = 1; n <= 8; n++) {
    for (const m of DICE_SIDES) {
      const d = `${n}d${m}`;
      const avg = averageHundredths(d);
      const out = range && (avg < range.min || avg > range.max) ? 1_000_000 : 0;
      const score = out + Math.abs(avg - targetH) * 10 + n;
      if (score < bestScore) { bestScore = score; best = d; }
    }
  }
  return best;
}

/** The biggest dice whose average does not exceed the target (1d4 at minimum). */
function diceAtMost(targetH: number): string {
  let best = "1d4";
  let bestAvg = -1;
  for (let n = 1; n <= 8; n++) {
    for (const m of DICE_SIDES) {
      const d = `${n}d${m}`;
      const avg = averageHundredths(d);
      if (avg <= targetH && avg > bestAvg) { bestAvg = avg; best = d; }
    }
  }
  return best;
}

// ---------- abilities ----------

function fillTemplate(tpl: KitAbilityTemplate, level: number, role: EnemyRole): Ability {
  const caps = levelCaps(level);
  const power = K.abilities.rolePowerPct[role];
  const ability = structuredClone(tpl) as unknown as Ability & { effects: Record<string, unknown>[] };
  ability.v = 1;
  ability.effects = tpl.effects.map((fx) => {
    const e = { ...fx } as Record<string, unknown>;
    if (typeof e.dicePct === "number") {
      e.dice = diceAtMost(Math.floor((caps.maxAverage * 100 * e.dicePct * power) / 10000));
      delete e.dicePct;
    }
    if (typeof e.absorbBase === "number") {
      const per = typeof e.absorbPerLevel === "number" ? e.absorbPerLevel : 0;
      e.absorb = clampN(Math.round(((e.absorbBase + per * level) * power) / 100), 1, 40);
      delete e.absorbBase;
      delete e.absorbPerLevel;
    }
    return e;
  }) as Ability["effects"];
  return clampAbilityToLevel(ability, level).ability;
}

function pickTheme(conceptTokens: ReadonlySet<string>, settingTokens: ReadonlySet<string>): { theme: KitTheme; hits: string[] } {
  let best: KitTheme | undefined;
  let bestHits: string[] = [];
  let bestScore = 0;
  for (const t of K.themes) {
    const own = matched(t.keywords, conceptTokens);
    const env = matched(t.keywords, settingTokens);
    const score = 3 * own.length + env.length;
    if (score > bestScore) { best = t; bestScore = score; bestHits = [...own, ...env]; }
  }
  if (best) return { theme: best, hits: bestHits };
  return { theme: K.themes.find((t) => t.id === K.defaultTheme) as KitTheme, hits: [] };
}

// ---------- behavior ----------

function composeBehavior(rng: Rng, role: EnemyRole, tokens: ReadonlySet<string>, notes: string[]): string[] {
  const B = K.behavior;
  const usedGroups = new Set<string>();
  const hit = [];
  for (const fam of B.families) {
    if (fam.group && usedGroups.has(fam.group)) continue;
    if (matched(fam.keywords, tokens).length === 0) continue;
    if (fam.group) usedGroups.add(fam.group);
    hit.push(fam);
  }
  if (hit.length > 0) notes.push(`behavior: ${hit.map((f) => f.id).join(", ")}`);
  const lines: string[] = [];
  for (const fam of hit) {
    const variant = rng.pick(fam.variants);
    // With several tactics each contributes its tactic line; alone, a family gives its full variant.
    if (hit.length > 1) lines.push(variant[0] as string);
    else lines.push(...variant);
  }
  const fillers = shuffle(rng, B.fillers[role]);
  for (const f of fillers) if (lines.length < B.minLines) lines.push(f);
  return lines.slice(0, B.maxLines);
}

// ---------- builder ----------

interface Plan {
  name: string; concept: string; role: EnemyRole; level: number;
  stats: Enemy["stats"]; behavior: string[]; theme: KitTheme; themeMatched: boolean; spriteTags: string[]; abilities: Ability[];
}

function toDraft(p: Plan, abilities: Ability[]): EnemyDraft {
  return {
    v: 1, name: p.name, concept: p.concept, role: p.role, stats: p.stats,
    weakness: p.theme.weakness, resistance: p.theme.resistance, behavior: p.behavior,
    loot_hint: p.theme.lootHint, sprite_tags: p.spriteTags, abilities,
  } as unknown as EnemyDraft;
}

function attempt(p: Plan, abilities: Ability[], notes: string[], label: string): Enemy | undefined {
  const { enemy, notes: cn } = clampEnemy(toDraft(p, abilities), p.level);
  if (validateEnemy(enemy, p.level).ok && enemy.role === p.role) {
    if (cn.length > 0) notes.push(`${label}: clamped (${cn.join("; ")})`);
    return enemy;
  }
  notes.push(`${label}: still invalid (${validateEnemy(enemy, p.level).errors.join("; ")})`);
  return undefined;
}

export function buildEnemyOffline(input: BuildEnemyInput): BuildEnemyResult {
  const role = input.role;
  const level = clampLevel(input.partyLevel);
  const notes: string[] = [];
  const concept = cleanConcept(input.concept ?? "", role);
  const refName = input.ref ? enemyNameFromRef(input.ref) : undefined;
  const name = refName ?? enemyNameFromConcept(concept, role);
  notes.push(refName ? `name from ref ${input.ref}` : "name from concept");

  const rng = createRng(hashSeed(input.seed, concept, input.ref ?? ""));
  const conceptTokens = tokensOf(`${name} ${concept}`);
  const settingTokens = tokensOf(input.settingNotes ?? "");

  // Stats: the middle of the role's range, shifted by traits, with a little seeded variation.
  const V = K.variation;
  const rg = enemyRangesForLevel(level, role);
  const traits = K.traits.filter((t) => matched(t.keywords, conceptTokens).length > 0);
  if (traits.length > 0) notes.push(`traits: ${traits.map((t) => t.id).join(", ")}`);
  const sum = (f: (t: (typeof K.traits)[number]) => number) => traits.reduce((a, t) => a + f(t), 0);
  const jitter = () => rng.int(-V.jitterPct, V.jitterPct);
  const hpPos = V.startPct + sum((t) => t.hpPct) + jitter();
  const defPos = V.startPct + sum((t) => t.defensePct) + jitter();
  const atkPos = V.startPct + sum((t) => t.attackPct) + jitter();
  const dmgPos = V.startPct + sum((t) => t.damagePct) + jitter();
  const speedKick = rng.int(1, 100) <= V.speedJitterChancePct ? (rng.int(0, 1) === 0 ? -1 : 1) : 0;
  const speed = clampN(RULES.speed.base + sum((t) => t.speed) + speedKick, ENEMY_DATA.speedRange.min, ENEMY_DATA.speedRange.max);
  const dmgRange = rg.damageHundredths;
  const stats: Enemy["stats"] = {
    hp: atPct(rg.hp, hpPos),
    defense: atPct(rg.defense, defPos),
    attack_bonus: atPct(rg.attack, atkPos),
    speed,
    damage_dice: diceNear(dmgRange.min + ((clampN(dmgPos, 0, 100) * (dmgRange.max - dmgRange.min)) / 100), dmgRange),
  };

  const { theme, hits } = pickTheme(conceptTokens, settingTokens);
  notes.push(`theme: ${theme.id}${hits.length > 0 ? ` (matched ${hits.join(", ")})` : " (default)"}`);

  const behavior = composeBehavior(rng, role, conceptTokens, notes);

  const tags: string[] = [];
  for (const row of K.spriteTags) if (matched(row.keywords, conceptTokens).length > 0) tags.push(...row.tags);
  if (hits.length > 0) tags.push(...theme.spriteTags);
  const spriteTags = [...new Set(tags)].filter((t) => t.length > 0 && t.length <= 24).slice(0, 5);

  const roleInfo = ENEMY_DATA.roles[role];
  const want = clampN(K.abilities.targetCount[role], roleInfo.abilitiesMin, roleInfo.abilitiesMax);
  const abilities = shuffle(rng, theme.templates).slice(0, want).map((t) => fillTemplate(t, level, role));
  notes.push(`abilities: ${abilities.map((a) => a.name).join(", ") || "none"}`);

  const plan: Plan = { name, concept, role, level, stats, behavior, theme, themeMatched: hits.length > 0, spriteTags, abilities };

  // 1. as planned, 2. fewer abilities, 3. a plain block.
  const first = attempt(plan, abilities, notes, "build");
  if (first) return { enemy: first, notes };
  if (abilities.length > roleInfo.abilitiesMin) {
    const second = attempt(plan, abilities.slice(0, roleInfo.abilitiesMin), notes, "fewer abilities");
    if (second) return { enemy: second, notes };
  }
  const plain: Plan = {
    ...plan,
    stats: {
      hp: atPct(rg.hp, 50), defense: atPct(rg.defense, 50), attack_bonus: atPct(rg.attack, 50), speed: RULES.speed.base,
      damage_dice: diceNear((dmgRange.min + dmgRange.max) / 2, dmgRange),
    },
  };
  const minAbilities = Array.from({ length: roleInfo.abilitiesMin }, () => fillTemplate(K.abilities.fallback, level, role));
  if (minAbilities.length > 1) minAbilities.forEach((a, i) => { a.name = `${a.name} ${i + 1}`.slice(0, 40); });
  const third = attempt(plain, minAbilities, notes, "plain stat block");
  if (third) return { enemy: third, notes };
  // Not reachable with the shipped data; return the clamped plain block rather than throw.
  notes.push("last resort: returned the clamped plain block without a passing validation");
  return { enemy: clampEnemy(toDraft(plain, minAbilities), level).enemy, notes };
}
