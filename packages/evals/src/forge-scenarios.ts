import { abilityCost, levelCaps, validateAbilityForLevel } from "@aedm/engine";
import { fixtures, type Ability, type Character } from "@aedm/schemas";
import { partyAbilities, type ForgeOutcome } from "@aedm/server/src/forge";
import { expect, verdict } from "./checks";
import type { CheckResult, ForgeScenario } from "./types";

const SOFT = 0.8;
const CAPS = levelCaps(1);

type Who = ForgeScenario["who"];
const BRINDLE: Who = { name: "Brindle Ash", title: "demolitions expert", description: "A soot-streaked tinkerer with a satchel of fuses and a patient smile." };
const TAMSIN: Who = { name: "Tamsin Quickfoot", title: "courier and speedster", description: "A wiry courier who is never quite where you last saw her." };
const ORRIN: Who = { name: "Orrin Vale", title: "marsh herbalist", description: "A calm herbalist who smells faintly of peat and mint." };
const ISELLE: Who = { name: "Dame Iselle Corvane", title: "disgraced duelist", description: "A once-famous duelist stripped of her title, still immaculate with a blade." };
const MAREN: Who = { name: "Maren", title: "retired chorister", description: "A former chapel singer whose voice still carries further than it should." };

/** Every ability is level 1 legal, and together they fit the level's power budget. */
function sound(o: ForgeOutcome, count: number): (string | undefined)[] {
  const total = o.abilities.reduce((n, a) => n + abilityCost(a), 0);
  return [
    expect(o.abilities.length === count, `forged ${o.abilities.length} abilities, expected ${count}`),
    ...o.abilities.flatMap((a) => validateAbilityForLevel(a, 1).errors.map((e) => `${a.name}: ${e}`)),
    expect(total <= CAPS.budget, `total cost ${total} is over the level 1 budget of ${CAPS.budget}`),
  ];
}

const forgeNotes = (o: ForgeOutcome): string => o.abilities.map((a) => a.forge_notes ?? "").join(" ");
const explained = (o: ForgeOutcome): boolean => forgeNotes(o).trim() !== "" || o.notices.some((n) => /could not do this as written/.test(n));

function forge(
  id: string, description: string, who: Who, texts: string[], check: (o: ForgeOutcome) => CheckResult, context?: ForgeScenario["context"],
): ForgeScenario {
  return { kind: "forge", id, category: "Forge", description, threshold: SOFT, who, texts, check, ...(context ? { context } : {}) };
}

/** An ordinary ability: forged in budget, with the engine's cost within 2 of the worked example in rules-numbers.md. */
function ordinary(id: string, who: Who, name: string, text: string): ForgeScenario {
  const expected = fixtures.ABILITY_FIXTURES_BY_NAME[name]!.expectedCost;
  return forge(id, `${name}: in budget, cost within 2 of ${expected}`, who, [`${name}: ${text}`], (o) => {
    const cost = o.abilities[0] ? abilityCost(o.abilities[0]) : 0;
    return verdict([...sound(o, 1), expect(Math.abs(cost - expected) <= 2, `cost ${cost}, expected ${expected} within 2`)]);
  });
}

/** An idea the engine cannot do as written: the closest legal version, explained. */
function toneDown(id: string, who: Who, name: string, text: string): ForgeScenario {
  return forge(id, `${name}: valid, in budget, explained`, who, [`${name}: ${text}`],
    (o) => verdict([...sound(o, 1), expect(explained(o), "no forge_notes and no rejection explanation")]));
}

const FIRE_BURST: Ability = {
  ...fixtures.fixtureAbility("Shaped Charge"),
  id: "ab_fire_burst", name: "Fire Burst", description: "Hurl a burst of flame that scorches everything in a small area.",
  effects: [{ type: "damage", shape: "burst", radius_tiles: 1, dice: "2d6", damage_type: "fire", save: { ability: "dex", dc: "caster_dc" }, on_save: "half", affects: "enemies" }],
};
const TEAMMATE: Character = { ...fixtures.BRINDLE, abilities: [FIRE_BURST] };

export const FORGE_SCENARIOS: ForgeScenario[] = [
  ordinary("F01", BRINDLE, "Shaped Charge", "Plant and detonate a directional charge. It blasts a small area and stuns anyone caught in it."),
  ordinary("F02", BRINDLE, "Tripwire Cache", "Lay a hidden tripwire across a corridor. The first enemy to cross it takes a nasty cut."),
  ordinary("F03", BRINDLE, "Smoke Pop", "Throw a smoke bomb that blocks sight in a small area for a couple of turns."),
  ordinary("F04", TAMSIN, "Blink Rush", "Dash up to four tiles in a line and strike the first enemy I reach."),
  ordinary("F05", TAMSIN, "Feint and Fade", "After I attack, I slip away so attackers have trouble hitting me until my next turn."),
  ordinary("F06", TAMSIN, "Slipstream", "Give an ally a burst of speed for two turns."),
  ordinary("F07", ORRIN, "Mending Poultice", "Press a healing poultice on an adjacent ally to restore a few hit points."),
  ordinary("F08", ORRIN, "Bitterroot Snare", "Roots erupt and hold one enemy in place for two turns."),
  ordinary("F09", ORRIN, "Fog Lantern", "My lantern reveals hidden creatures and traps in a wide area."),
  forge("F10", "Riposte Stance: simplified, and says reactions are unsupported", ISELLE,
    ["Riposte Stance: I take a stance, and the next attack against me is turned back on the attacker."],
    (o) => verdict([...sound(o, 1), expect(/reaction/i.test(`${forgeNotes(o)} ${o.notices.join(" ")}`), "does not say reactions are unsupported")])),
  ordinary("F11", ISELLE, "Mark for the Blade", "Mark an enemy so my allies strike it more easily."),
  ordinary("F12", ISELLE, "Wounding Cut", "A precise cut that bleeds the target for three turns."),
  toneDown("F13", MAREN, "Reality Chorus", "Sing one chord that damages and stuns everything within four tiles for three turns."),
  toneDown("F14", MAREN, "Unwrite", "Erase any enemy from existence."),
  toneDown("F15", MAREN, "Hymn of Mending", "Heal the whole party to full health."),

  forge("F16", "Adaptation: a fireball in a drowned city", MAREN, ["Fireball: hurl a ball of fire"],
    (o) => verdict([...sound(o, 1), expect(forgeNotes(o).trim() !== "", "forge_notes is empty")]),
    { campaign: { title: "The Drowned City of Saltreach", digest: "A flooded city of canals and sunken towers, where fire is scarce and the water is never still.", tone: "damp, eerie, salt-bitten" } }),

  forge("F17", "Party overlap: a teammate already has a burst of fire", ORRIN, ["Fireball: hurl a ball of fire that explodes among my enemies."],
    (o) => {
      const a = o.abilities[0];
      const overlaps = a?.effects.some((e) => e.type === "damage" && e.shape === "burst" && e.damage_type === "fire") ?? false;
      const mentioned = /differ|distinct|unlike|already|similar|overlap|instead|duplicate/i.test(`${forgeNotes(o)} ${o.notices.join(" ")}`);
      return verdict([...sound(o, 1), expect(!overlaps || mentioned, "a burst of fire damage like the teammate's, with no note about it")]);
    },
    { party: partyAbilities([TEAMMATE]) }),

  forge("F18", "Budget fit: three ambitious abilities, all kept", MAREN,
    [
      "Inferno Storm: rain fire across a wide area, burning and stunning every enemy for several turns.",
      "Titan's Wrath: slam the ground for huge damage to all enemies nearby and knock them prone.",
      "Mass Revival: heal every ally to full health and grant them speed for a long time.",
    ],
    (o) => verdict([...sound(o, 3), ...o.notices.map((n) => expect(!n.startsWith("Dropped"), n))])),
];
