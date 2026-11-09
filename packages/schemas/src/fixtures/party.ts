import type { Character } from "../character";
import { fixtureAbility } from "./abilities";

const base = {
  v: 1 as const, campaign_id: "cmp_lantern_marsh", level: 1, growth: 0, weapon_tier: 1, armor_bonus: 2,
  inventory: [] as Character["inventory"],
};

export const BRINDLE: Character = {
  ...base,
  id: "ch_brindle", user_id: "u_brindle",
  name: "Brindle Ash", title: "demolitions expert",
  description: "A soot-streaked tinkerer with a satchel of fuses and a patient smile.",
  key_ability: "int",
  scores: { str: 10, dex: 13, con: 14, int: 15, wis: 10, cha: 10 },
  trait_tags: ["explosives", "crafting"],
  abilities: ["Shaped Charge", "Tripwire Cache", "Smoke Pop"].map(fixtureAbility),
  hp: 12, hp_max: 12,
  sprite_recipe: { kind: "shape", shape: "hex", color: "#c0562b", accent: "#3a2a1e", glyph: "B" },
};

export const TAMSIN: Character = {
  ...base,
  id: "ch_tamsin", user_id: "u_tamsin",
  name: "Tamsin Quickfoot", title: "courier and speedster",
  description: "A wiry courier who is never quite where you last saw her.",
  key_ability: "dex",
  scores: { str: 8, dex: 15, con: 12, int: 12, wis: 13, cha: 13 },
  trait_tags: ["speed", "stealth"],
  abilities: ["Blink Rush", "Feint and Fade", "Slipstream"].map(fixtureAbility),
  hp: 11, hp_max: 11,
  sprite_recipe: { kind: "shape", shape: "triangle", color: "#3f7fbf", accent: "#f2d45c", glyph: "T" },
};

export const ORRIN: Character = {
  ...base,
  id: "ch_orrin", user_id: "u_orrin",
  name: "Orrin Vale", title: "marsh herbalist",
  description: "A calm herbalist who smells faintly of peat and mint.",
  key_ability: "wis",
  scores: { str: 10, dex: 12, con: 13, int: 12, wis: 15, cha: 11 },
  trait_tags: ["medicine", "nature"],
  abilities: ["Mending Poultice", "Bitterroot Snare", "Fog Lantern"].map(fixtureAbility),
  hp: 11, hp_max: 11,
  sprite_recipe: { kind: "shape", shape: "circle", color: "#4f8f4a", accent: "#e8e0c0", glyph: "O" },
};

export const SPIKE_PARTY: Character[] = [BRINDLE, TAMSIN, ORRIN];
