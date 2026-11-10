import type { Ability } from "../ability";

export type AbilityFixture = {
  /** Ability exactly as the worked example in rules-numbers.md describes it. */
  ability: Ability;
  /** Cost from the "Worked examples" table. */
  expectedCost: number;
  /** Unrounded calculation, in hundredths, for the engine's integer-math tests. */
  expectedCostHundredths: number;
};

const save = { ability: "dex", dc: "caster_dc" } as const;

export const ABILITY_FIXTURES: AbilityFixture[] = [
  {
    expectedCost: 11,
    expectedCostHundredths: 1052,
    ability: {
      v: 1, id: "ab_shaped_charge", name: "Shaped Charge",
      description: "Plant and detonate a directional charge that blasts a small area and stuns anyone caught in it.",
      tags: ["explosives"], action: "action", target: "tile", range_tiles: 6, cooldown_turns: 3,
      effects: [
        { type: "damage", shape: "burst", radius_tiles: 1, dice: "2d6", damage_type: "blunt", save, on_save: "half", affects: "enemies" },
        { type: "condition", condition: "stunned", duration_turns: 1, on: "failed_save", save, affects: "enemies" },
      ],
    },
  },
  {
    expectedCost: 3,
    expectedCostHundredths: 300,
    ability: {
      v: 1, id: "ab_tripwire_cache", name: "Tripwire Cache",
      description: "Lay a hidden tripwire. The first enemy to cross it takes a nasty cut.",
      tags: ["crafting"], action: "action", target: "tile", range_tiles: 4, uses_per_rest: 2,
      effects: [{ type: "terrain", kind: "trap", shape: "tile", dice: "1d6", damage_type: "sharp" }],
    },
  },
  {
    expectedCost: 5,
    expectedCostHundredths: 449,
    ability: {
      v: 1, id: "ab_smoke_pop", name: "Smoke Pop",
      description: "Throw a smoke bomb that blocks sight in a small area for two turns.",
      tags: ["explosives"], action: "action", target: "tile", range_tiles: 6, cooldown_turns: 3,
      effects: [{ type: "terrain", kind: "smoke", shape: "burst", radius_tiles: 1, duration_turns: 2 }],
    },
  },
  {
    expectedCost: 5,
    expectedCostHundredths: 480,
    ability: {
      v: 1, id: "ab_blink_rush", name: "Blink Rush",
      description: "Dash up to four tiles in a line and strike the first enemy reached.",
      tags: ["speed"], action: "action", target: "enemy", range_tiles: 4, cooldown_turns: 1,
      effects: [
        { type: "dash", tiles: 4, with_attack: true },
        { type: "damage", shape: "single", dice: "1d6", damage_type: "sharp", affects: "enemies" },
      ],
    },
  },
  {
    expectedCost: 3,
    expectedCostHundredths: 240,
    ability: {
      v: 1, id: "ab_feint_and_fade", name: "Feint and Fade",
      description: "Slip away after attacking so attackers have trouble hitting you until your next turn.",
      tags: ["stealth"], action: "quick", target: "self", range_tiles: 0, cooldown_turns: 2,
      effects: [{ type: "condition", condition: "evasive", duration_turns: 1, on: "always" }],
    },
  },
  {
    expectedCost: 5,
    expectedCostHundredths: 408,
    ability: {
      v: 1, id: "ab_slipstream", name: "Slipstream",
      description: "Give an ally a burst of speed for two turns.",
      tags: ["speed"], action: "action", target: "ally", range_tiles: 4, cooldown_turns: 3,
      effects: [{ type: "condition", condition: "hasted", duration_turns: 2, on: "always", affects: "allies" }],
    },
  },
  {
    expectedCost: 3,
    expectedCostHundredths: 240,
    ability: {
      v: 1, id: "ab_mending_poultice", name: "Mending Poultice",
      description: "Press a healing poultice on an adjacent ally to restore a few hit points.",
      tags: ["medicine"], action: "action", target: "ally", range_tiles: 1, cooldown_turns: 2,
      effects: [{ type: "heal", shape: "single", dice: "2d4", affects: "allies" }],
    },
  },
  {
    expectedCost: 3,
    expectedCostHundredths: 224,
    ability: {
      v: 1, id: "ab_bitterroot_snare", name: "Bitterroot Snare",
      description: "Roots erupt and hold one enemy in place for two turns.",
      tags: ["nature"], action: "action", target: "enemy", range_tiles: 8, cooldown_turns: 3,
      effects: [
        { type: "condition", condition: "rooted", duration_turns: 2, on: "failed_save", save: { ability: "str", dc: "caster_dc" }, affects: "enemies" },
      ],
    },
  },
  {
    expectedCost: 2,
    expectedCostHundredths: 136,
    ability: {
      v: 1, id: "ab_fog_lantern", name: "Fog Lantern",
      description: "The lantern reveals hidden creatures and traps in a wide area.",
      tags: ["perception"], action: "action", target: "self", range_tiles: 0, cooldown_turns: 3,
      effects: [{ type: "reveal", radius_tiles: 2 }],
    },
  },
  {
    expectedCost: 3,
    expectedCostHundredths: 240,
    ability: {
      v: 1, id: "ab_riposte_stance", name: "Riposte Stance",
      description: "Take a defensive stance that makes attacks against you harder.",
      tags: [], action: "quick", target: "self", range_tiles: 0, cooldown_turns: 2,
      effects: [{ type: "condition", condition: "evasive", duration_turns: 1, on: "always" }],
      forge_notes: "Reactions are unsupported, so this is built as evasive for 1 turn instead of a counterattack.",
    },
  },
  {
    expectedCost: 2,
    expectedCostHundredths: 176,
    ability: {
      v: 1, id: "ab_mark_for_the_blade", name: "Mark for the Blade",
      description: "Mark an enemy so your allies strike it more easily.",
      tags: [], action: "quick", target: "enemy", range_tiles: 8, cooldown_turns: 2,
      effects: [{ type: "mark", duration_turns: 2, affects: "enemies" }],
    },
  },
  {
    expectedCost: 6,
    expectedCostHundredths: 512,
    ability: {
      v: 1, id: "ab_wounding_cut", name: "Wounding Cut",
      description: "A precise cut that bleeds the target for three turns.",
      tags: [], action: "action", target: "enemy", range_tiles: 1, cooldown_turns: 2,
      effects: [
        { type: "damage", shape: "single", dice: "1d6", damage_type: "sharp", affects: "enemies" },
        { type: "condition", condition: "bleeding", duration_turns: 3, on: "hit", affects: "enemies" },
      ],
    },
  },
  {
    expectedCost: 7,
    expectedCostHundredths: 619,
    ability: {
      v: 1, id: "ab_reality_chorus", name: "Reality Chorus",
      description: "Sing one chord that damages and briefly stuns everything close to the target point.",
      tags: ["performance"], action: "action", target: "tile", range_tiles: 6, uses_per_rest: 1,
      effects: [
        { type: "damage", shape: "burst", radius_tiles: 1, dice: "2d6", damage_type: "psychic", save: { ability: "con", dc: "caster_dc" }, on_save: "half", affects: "enemies" },
        { type: "condition", condition: "stunned", duration_turns: 1, on: "failed_save", save: { ability: "con", dc: "caster_dc" }, affects: "enemies" },
      ],
      forge_notes: "Toned down to level 1 caps: burst radius 1, stun 1 turn, 2d6 damage, once per rest.",
    },
  },
  {
    expectedCost: 2,
    expectedCostHundredths: 180,
    ability: {
      v: 1, id: "ab_hymn_of_mending", name: "Hymn of Mending",
      description: "A healing hymn that restores hit points to allies close by.",
      tags: ["performance"], action: "action", target: "self", range_tiles: 0, uses_per_rest: 1,
      effects: [{ type: "heal", shape: "burst", radius_tiles: 1, dice: "2d4", affects: "allies" }],
      forge_notes: "Toned down: heal 2d4 in a radius 1 burst, once per rest.",
    },
  },
];

export const ABILITY_FIXTURES_BY_NAME: Record<string, AbilityFixture> = Object.fromEntries(
  ABILITY_FIXTURES.map((f) => [f.ability.name, f]),
);

export function fixtureAbility(name: string): Ability {
  const f = ABILITY_FIXTURES_BY_NAME[name];
  if (!f) throw new Error(`no ability fixture named ${name}`);
  return f.ability;
}
