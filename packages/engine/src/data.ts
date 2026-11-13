/**
 * Typed access to the rules numbers in `packages/engine/data/*.json`.
 * Nothing in the engine hardcodes a rules number; it reads it from here.
 */
import type { PlotArc, PlotPattern, Condition, DamageType, Difficulty, Disposition, EnemyRole } from "@aedm/schemas";
import rulesJson from "../data/rules.json" with { type: "json" };
import levelsJson from "../data/levels.json" with { type: "json" };
import conditionsJson from "../data/conditions.json" with { type: "json" };
import costsJson from "../data/costs.json" with { type: "json" };
import enemiesJson from "../data/enemies.json" with { type: "json" };
import plotsJson from "../data/plots.json" with { type: "json" };
import pixelJson from "../data/pixel.json" with { type: "json" };
import lootJson from "../data/loot.json" with { type: "json" };
import interactJson from "../data/interact.json" with { type: "json" };

export interface ArmorInfo { name: string; dexCap: number | null; speedPenalty: number }

export interface Rules {
  version: number;
  abilityModifier: { base: number; divisor: number };
  scores: { min: number; max: number; creationMin: number; creationMax: number };
  pointBuy: { budget: number; costs: Record<string, number> };
  levelCap: number;
  scoreIncreaseLevels: number[];
  growth: {
    perLevel: number; milestoneAward: number; contextualMin: number; contextualMax: number;
    sessionPointCap: number; sessionAwardCap: number;
  };
  hp: { level1Base: number; perLevelBase: number; perLevelMin: number };
  defense: { base: number };
  speed: { base: number; hasted: number; slowed: number; min: number; heavyArmor: number };
  checks: {
    dcMin: number; dcMax: number; tagBonus: number; diceSides: number;
    partySuccessNum: number; partySuccessDen: number;
    dcGuide: Record<string, number>; tags: string[];
  };
  armor: Record<string, ArmorInfo>;
  armorTierBonus: Record<string, number>;
  weaponTiers: Record<string, string>;
  starting: { weaponTier: number; armorBonus: number };
  attack: { meleeRange: number; rangedRange: number; critDiceMultiplier: number; rangedKeyAbilities: string[]; pcDamageType: DamageType; enemyDamageType: DamageType; minDamage: number };
  sprites: { shapes: string[]; palette: string[]; accents: string[] };
  exploration: { maxMoveTiles: number };
  npc: { dispositionByRole: Record<string, Disposition>; maxQuests: number; maxQuestNotes: number; maxInventory: number; maxFacts: number; linesKept: number; notesKept: number; dossierMax: number; allyStatPct: number; combatSafeActions: string[]; maxCombatConditions: number; maxOpenThreads: number; maxThreads: number };
  draught: { name: string; dice: string; bonus: number; value: number; action: string };
  loot: { base: number; perLevel: number };
  damage: { types: DamageType[]; weaknessNum: number; weaknessDen: number; resistanceNum: number; resistanceDen: number };
  downed: { roundsUntilOut: number; reviveDc: number; reviveAbility: string; reviveHp: number; wakeHp: number; absentMinHp: number };
  rest: { hpFractionNum: number; hpFractionDen: number };
  turn: { standCost: number; ownTurnConditionExtra: number };
  initiative: { enemyBonus: number; enemyDexScore: number };
  enemySave: { num: number; den: number; dcBase: number };
  saveDcBase: number;
  abilityDurationCap: { conditions: Condition[] };
  abilityLimits: { maxRange: number; maxAbilitiesPerCharacter: number };
  powerBudget: { base: number; perLevel: number; perAbilityCapPct: number };
  maxAverageEffect: { base: number; perLevel: number };
  log: { maxEvents: number };
  ai: {
    rangedPattern: string;
    healBelowPct: number;
    tactics: Record<Tactic, string>;
    leaderRoles: EnemyRole[];
    leaderGuardRadius: number;
    morale: {
      breakBelowPct: Record<EnemyRole, number>;
      cowardlyBonusPct: number;
      checkDc: number;
      leaderDownBreaksMinions: boolean;
      fleeDistance: number;
      bloodiedPct: number;
    };
  };
}

/** Enemy tactics the engine recognises in an archetype's `behavior` text (`rules.ai.tactics` holds the patterns). */
export type Tactic = "focus_weakest" | "target_healer" | "protect_leader" | "pack" | "fearless" | "cowardly";

export interface LevelRow {
  level: number; proficiency: number; budget: number; perAbilityCap: number; maxAverage: number;
  maxRadius: number; maxConditionTurns: number; maxStunTurns: number; weaponTier: number;
}

export interface ConditionMeta {
  hostile: boolean;
  canAct?: boolean;
  canMove?: boolean;
  attackedAdvantage?: boolean;
  speedDelta?: number;
  speedSet?: number;
  defenseDelta?: number;
  adjacentAttackAdvantage?: boolean;
  rangedAttackDisadvantage?: boolean;
  startOfTurnDamage?: { dice: string; type: DamageType };
  extinguishWithAction?: boolean;
  endsOnHeal?: boolean;
  attackedToHit?: number;
  attackDisadvantageExceptSource?: boolean;
  attackDisadvantage?: boolean;
  attackedDisadvantage?: boolean;
}

export interface Costs {
  unit: number; minCost: number;
  damagePriceDivisor: number; healPriceDivisor: number; shieldDivisor: number;
  pushPullDivisor: number; dashDivisor: number; teleportPerTile: number; teleportMaxTiles: number;
  revealPrice: number; disarmPrice: number; markPricePerTurn: number;
  conditionPerTurn: Record<string, number>;
  terrain: Record<string, number>;
  terrainTimed: string[];
  checkBonus: { low: number; high: number; lowMaxBonus: number };
  durationMultipliers: Record<string, number>;
  area: { single: number; burst1: number; burst2: number; line: number; cone: number };
  save: { save: number; none: number };
  range: { maxTiles: number; mult: number }[];
  cooldown: Record<string, number>;
  cooldownMaxKey: number;
  uses: Record<string, number>;
}

export interface EnemyTableRow { level: number; hp: number; defense: number; attack: number; damage: number; threat: number }
export interface RoleInfo { hpPct: number; damagePct: number; abilitiesMin: number; abilitiesMax: number }
export interface EnemyData {
  threat: {
    hpHundredthsPerHp: number; defenseBase: number; defenseHundredths: number; damageHundredthsMult: number;
    abilityCostHundredths: number; speedBase: number; speedHundredths: number;
  };
  table: EnemyTableRow[];
  tolerance: { hpPct: number; damagePct: number; defense: number; attack: number };
  speedRange: { min: number; max: number };
  roles: Record<EnemyRole, RoleInfo>;
  budget: { perCharacterBase: number; perLevel: number; bossMultiplierPct: number };
  difficultyPct: Record<Difficulty, number>;
}

export const RULES = rulesJson as unknown as Rules;
export const LEVELS = (levelsJson as unknown as { levels: LevelRow[] }).levels;
export const CONDITION_META = conditionsJson as unknown as Record<Condition, ConditionMeta>;
export const COSTS = costsJson as unknown as Costs;
export const ENEMY_DATA = enemiesJson as unknown as EnemyData;

export interface PlotStageData { id: string; name: string; purpose: string; tension: number; difficulty: Difficulty }
export interface PlotPatternData { name: string; shape: string; keywords: string[]; recommendedArcs: PlotArc[]; stages: PlotStageData[] }
export interface PlotArcData { name: string; curve: string; /** Party fortune (0 to 10) at the end of each stage. */ fortune: number[] }
export interface PlotsData {
  version: number;
  fortune: { start: number; min: number; max: number };
  limits: { maxMilestones: number };
  patterns: Record<PlotPattern, PlotPatternData>;
  arcs: Record<PlotArc, PlotArcData>;
}
export const PLOTS = plotsJson as unknown as PlotsData;

/** Limits for player-painted sprites (see pixel.ts). */
export interface PixelRules { maxColors: number; minOpaque: number; margin: number; feetY: number; feetTolerance: number; maxRecipeBytes: number }
export const PIXEL_RULES: PixelRules = pixelJson;

// ---------- containers, locks, doors and loot (data/interact.json, data/loot.json) ----------

export type ActionCost = "action" | "quick" | "free" | "refuse";

export interface LootTemplate {
  name: string;
  kind: "consumable" | "weapon" | "armor" | "trinket";
  /** Gold-equivalent value. Omitted for the healing draught, which takes `RULES.draught.value` and name. */
  value?: number;
  weight: number;
  /** Gear tier (weapon and armor): only rolled when the tier allowance reaches it. */
  tier?: number;
  /** Non-gear items: only rolled when the tier allowance reaches it. Default 1. */
  minTier?: number;
  draught?: true;
}
export interface LootData {
  version: number;
  kindWeights: Record<string, number>;
  roll: { minItems: number; maxItems: number };
  templates: LootTemplate[];
}

export interface InteractData {
  version: number;
  /** Chebyshev distance an actor may be from a container, door, lever or sign. */
  reach: number;
  examineReach: number;
  /** Items one character may carry through taking, receiving or picking up (the schema ceiling is 100). */
  inventoryCap: number;
  pileCap: number;
  noTransferKinds: string[];
  combatCost: Record<string, ActionCost>;
  locks: {
    dcByTier: Record<string, number>;
    variance: number;
    defaultTier: number;
    pick: { ability: "str" | "dex"; tag: string; dcBonus: number };
    force: { ability: "str" | "dex"; tag: string; dcBonus: number; noiseRadius: number };
    consumeKey: boolean;
  };
  doors: { blockWhenClosed: boolean; generated: { enabled: boolean; closedPct: number; lockedPct: Record<string, number> } };
  levers: { maxLinks: number };
  chest: { budgetPct: number; maxItems: number };
  slot: { budgetPct: number; itemsPerCount: number };
  remains: {
    dropWeights: Record<string, { nothing: number; loot: number }>;
    budgetPct: Record<string, number>;
    maxItems: Record<string, number>;
  };
  signs: { templates: Record<string, string[]> };
  texts: Record<string, Record<string, string>>;
}

export const LOOT = lootJson as unknown as LootData;
export const INTERACT = interactJson as unknown as InteractData;
