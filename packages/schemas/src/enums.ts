import { z } from "zod";

export const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"] as const;
export const AbilityScoreKeySchema = z.enum(ABILITIES);
export type AbilityScoreKey = z.infer<typeof AbilityScoreKeySchema>;

export const CHECK_TAGS = [
  "athletics", "stealth", "speed", "perception", "survival", "nature",
  "medicine", "lore", "crafting", "explosives", "lockpicking", "persuasion",
  "deception", "intimidation", "performance", "leadership", "tinkering", "animals",
] as const;
export const CheckTagSchema = z.enum(CHECK_TAGS);
export type CheckTag = z.infer<typeof CheckTagSchema>;

export const CONDITIONS = [
  "stunned", "slowed", "rooted", "prone", "burning", "bleeding",
  "shielded", "hasted", "marked", "taunted", "dazzled", "evasive",
] as const;
export const ConditionSchema = z.enum(CONDITIONS);
export type Condition = z.infer<typeof ConditionSchema>;

export const DAMAGE_TYPES = ["fire", "cold", "lightning", "acid", "blunt", "sharp", "psychic", "radiant"] as const;
export const DamageTypeSchema = z.enum(DAMAGE_TYPES);
export type DamageType = z.infer<typeof DamageTypeSchema>;

export const TERRAIN_KINDS = ["wall", "fire", "trap", "smoke"] as const;
export const TerrainKindSchema = z.enum(TERRAIN_KINDS);
export type TerrainKind = z.infer<typeof TerrainKindSchema>;

/** Legacy: the five original biomes. Maps and briefs no longer carry one (they carry `setting`); the engine's compatibility generator still maps a preset to one of these. */
export const BIOMES = ["forest", "dungeon", "desert", "town", "interior"] as const;
export const BiomeSchema = z.enum(BIOMES);
export type Biome = z.infer<typeof BiomeSchema>;

/** Shapes of damage and heal effects. */
export const EFFECT_SHAPES = ["single", "burst", "line", "cone"] as const;
export const EffectShapeSchema = z.enum(EFFECT_SHAPES);
export type EffectShape = z.infer<typeof EffectShapeSchema>;

/** Shapes of terrain effects. */
export const TERRAIN_SHAPES = ["tile", "burst", "line"] as const;
export const TerrainShapeSchema = z.enum(TERRAIN_SHAPES);
export type TerrainShape = z.infer<typeof TerrainShapeSchema>;

export const AFFECTS = ["enemies", "allies", "all"] as const;
export const AffectsSchema = z.enum(AFFECTS);
export type Affects = z.infer<typeof AffectsSchema>;

export const ABILITY_ACTIONS = ["action", "quick"] as const;
export const AbilityActionSchema = z.enum(ABILITY_ACTIONS);
export type AbilityAction = z.infer<typeof AbilityActionSchema>;

export const ABILITY_TARGETS = ["self", "ally", "enemy", "any", "tile"] as const;
export const AbilityTargetSchema = z.enum(ABILITY_TARGETS);
export type AbilityTarget = z.infer<typeof AbilityTargetSchema>;

export const CONDITION_TRIGGERS = ["hit", "failed_save", "always"] as const;
export const ConditionTriggerSchema = z.enum(CONDITION_TRIGGERS);
export type ConditionTrigger = z.infer<typeof ConditionTriggerSchema>;

export const ON_SAVE = ["half", "none"] as const;
export const OnSaveSchema = z.enum(ON_SAVE);
export type OnSave = z.infer<typeof OnSaveSchema>;

export const NPC_ROLES = ["merchant", "quest_giver", "ally", "bystander", "villain"] as const;
export const NpcRoleSchema = z.enum(NPC_ROLES);
export type NpcRole = z.infer<typeof NpcRoleSchema>;

export const ENEMY_ROLES = ["minion", "standard", "elite", "boss"] as const;
export const EnemyRoleSchema = z.enum(ENEMY_ROLES);
export type EnemyRole = z.infer<typeof EnemyRoleSchema>;

export const DIFFICULTIES = ["easy", "standard", "hard", "deadly"] as const;
export const DifficultySchema = z.enum(DIFFICULTIES);
export type Difficulty = z.infer<typeof DifficultySchema>;

export const ITEM_KINDS = ["consumable", "weapon", "armor", "trinket", "quest"] as const;
export const ItemKindSchema = z.enum(ITEM_KINDS);
export type ItemKind = z.infer<typeof ItemKindSchema>;

export const QUEST_STATUSES = ["new", "active", "done", "failed"] as const;
export const QuestStatusSchema = z.enum(QUEST_STATUSES);
export type QuestStatus = z.infer<typeof QuestStatusSchema>;

export const DISPOSITIONS = ["friendly", "neutral", "wary", "hostile"] as const;
export const DispositionSchema = z.enum(DISPOSITIONS);
export type Disposition = z.infer<typeof DispositionSchema>;

export const ADVANTAGES = ["none", "advantage", "disadvantage"] as const;
export const AdvantageSchema = z.enum(ADVANTAGES);
export type Advantage = z.infer<typeof AdvantageSchema>;

export const ROOM_TYPES = [
  "hall", "chamber", "corridor", "courtyard", "cave", "outdoor", "street", "deck", "vault", "garden", "shore",
] as const;
export const RoomTypeSchema = z.enum(ROOM_TYPES);
export type RoomType = z.infer<typeof RoomTypeSchema>;

/** Room sizes (also used for any small/medium/large choice). */
export const SIZES = ["small", "medium", "large"] as const;
export const SizeSchema = z.enum(SIZES);
export type Size = z.infer<typeof SizeSchema>;

export const SIZE_CLASSES = ["small", "medium", "large"] as const;
export const SizeClassSchema = z.enum(SIZE_CLASSES);
export type SizeClass = z.infer<typeof SizeClassSchema>;

export const EXIT_SIDES = ["north", "south", "east", "west"] as const;
export const ExitSideSchema = z.enum(EXIT_SIDES);
export type ExitSide = z.infer<typeof ExitSideSchema>;

export const ENTITY_SLOT_ROLES = ["enemy", "npc", "boss", "loot"] as const;
export const EntitySlotRoleSchema = z.enum(ENTITY_SLOT_ROLES);
export type EntitySlotRole = z.infer<typeof EntitySlotRoleSchema>;

export const INTERACTABLE_KINDS = ["chest", "door", "lever", "sign", "altar"] as const;
export const InteractableKindSchema = z.enum(INTERACTABLE_KINDS);
export type InteractableKind = z.infer<typeof InteractableKindSchema>;

export const INTERACTABLE_STATES = ["open", "closed", "locked"] as const;
export const InteractableStateSchema = z.enum(INTERACTABLE_STATES);
export type InteractableState = z.infer<typeof InteractableStateSchema>;

export const DIRECTIONS = ["n", "s", "e", "w"] as const;
export const DirectionSchema = z.enum(DIRECTIONS);
export type Direction = z.infer<typeof DirectionSchema>;

export const CONTENT_RATINGS = ["family", "teen", "mature"] as const;
export const ContentRatingSchema = z.enum(CONTENT_RATINGS);
export type ContentRating = z.infer<typeof ContentRatingSchema>;

export const PLAYER_STATUSES = ["online", "away", "offline", "autopilot"] as const;
export const PlayerStatusSchema = z.enum(PLAYER_STATUSES);
export type PlayerStatus = z.infer<typeof PlayerStatusSchema>;

export const SPRITE_SHAPES = ["circle", "square", "diamond", "triangle", "hex"] as const;
export const SpriteShapeSchema = z.enum(SPRITE_SHAPES);
export type SpriteShape = z.infer<typeof SpriteShapeSchema>;

/** Named shortcuts that fill missing materials. The first five are the old biomes; their data lives in the engine. */
export const SETTING_PRESETS = [
  "forest", "dungeon", "desert", "town", "interior",
  "cave", "swamp", "snowfield", "mountain_pass", "ruins", "temple", "castle", "ship_deck", "sewer",
  "volcanic", "crypt", "library", "market", "farmland", "beach",
] as const;
export const SettingPresetSchema = z.enum(SETTING_PRESETS);
export type SettingPreset = z.infer<typeof SettingPresetSchema>;

/** The layout generators. Every setting picks the closest one. */
export const LAYOUTS = ["rooms_and_corridors", "cave", "open_field", "settlement", "trail", "arena", "maze", "islands"] as const;
export const LayoutSchema = z.enum(LAYOUTS);
export type Layout = z.infer<typeof LayoutSchema>;

export const ENVIRONMENTS = ["indoor", "outdoor", "underground"] as const;
export const EnvironmentSchema = z.enum(ENVIRONMENTS);
export type Environment = z.infer<typeof EnvironmentSchema>;

export const MOODS = ["bright", "neutral", "dim", "dark", "eerie"] as const;
export const MoodSchema = z.enum(MOODS);
export type Mood = z.infer<typeof MoodSchema>;
