import type { WorldFact } from "@aedm/schemas";
import type { DmContextPack, PartyMemberContext, PacingContext, SceneEntity } from "../context";
import { makeLanternPack } from "../testing";

/** Deterministic DM context fixtures for token budgets and compaction work. Pure data, no randomness. */

const NAMES = ["Brindle Ash", "Tamsin Quickfoot", "Orrin Vale", "Mira Thorne", "Joss Wren", "Pell Dunmore"];
const TITLES = ["demolitions expert", "courier and speedster", "marsh herbalist", "lantern-keeper", "retired bell-ringer", "river-pilot"];
const TAGS = [["explosives", "crafting"], ["speed", "stealth"], ["medicine", "nature"], ["lore", "persuasion"], ["athletics", "intimidation"], ["navigation", "survival"]];
const ABILITIES = [
  "Powder Keg: hurl a bundle of sparking powder, 2d6 fire damage in radius 2, costs 3 stamina",
  "Quick Step: dash up to 6 tiles without provoking, once per scene",
  "Mending Poultice: heal an ally within 1 tile for 2d4 HP",
  "Bell Toll: stun enemies within 3 tiles for 1 round",
  "Reed Snare: pin a target in place for 2 rounds, DC 13 to escape",
  "Lantern Flash: blind enemies in a cone for 1 round",
];
const ITEMS = ["rope (50 ft)", "healing draught", "flint and steel", "iron lantern", "marsh-lily satchel", "brass key", "salted fish", "waterskin", "chalk stub", "bent dagger", "wax-sealed letter", "lucky coin"];
const SUBJECTS = ["Odalys Brand", "Hollowmere", "Edda Marrow", "The Reed Court", "Old Bell Tower", "Lantern Marsh", "Captain Hesk", "The Sunken Chapel", "Mother Gall", "The Tallow Road"];
const PREDICATES = ["runs", "is located near", "fears", "owes a debt to", "guards", "was last seen at", "keeps secret", "holds the key to"];
const OBJECTS = [
  "the inn at the edge of the square, and speaks to no one about the cult",
  "the marsh path, which floods at night and hides the old causeway",
  "a hidden ledger listing every family that paid the cult in the last decade",
  "the sunken chapel, where the lanterns are lit by something other than fire",
];

const TURN_DM = [
  "The square falls quiet as the lantern-light flickers. Odalys sets down her ladle and watches you from the inn doorway, one hand on the frame. Beyond her the marsh path is a ribbon of black water and pale reeds, and somewhere out there a bell tolls once, slowly.",
  "Brindle's powder bursts against the causeway stones in a rolling orange flash. Two reed-cloaked figures stagger back, their lanterns guttering. The third, taller than the others, simply walks through the smoke toward you, unhurried.",
  "The ledger is damp but legible. Names run down the page in a careful hand, each with a sum and a date. Near the bottom, one entry is circled in red: Marrow, E. - paid in full - taken.",
];
const TURN_PLAYER = [
  "I step in front of the others and ask Odalys directly what she knows about Edda Marrow, keeping my voice low so the square can't hear.",
  "Tamsin slips along the wall toward the marsh path and checks whether anyone is following us.",
  "I throw a bundle of powder at the tall figure and shout for everyone to get behind the cart.",
];

const pad = (n: number) => String(n).padStart(2, "0");

function member(i: number, abilityCount: number, itemCount: number): PartyMemberContext {
  const k = i % NAMES.length;
  const id = `ch_${NAMES[k]!.split(" ")[0]!.toLowerCase()}`;
  return {
    id, name: NAMES[k]!, title: TITLES[k]!, level: 3, hp: 18 - (i % 3) * 2, hpMax: 18, tags: TAGS[k]!,
    abilities: Array.from({ length: abilityCount }, (_, j) => (j === 0 ? ABILITIES[k]! : `${ABILITIES[(k + j) % ABILITIES.length]!} (variant ${j})`)),
    inventory: Array.from({ length: itemCount }, (_, j) => ITEMS[(k + j) % ITEMS.length]!),
    playerName: `player_${k + 1}`, present: i % 5 !== 4,
  };
}

function facts(n: number): WorldFact[] {
  return Array.from({ length: n }, (_, i) => ({
    subject: SUBJECTS[i % SUBJECTS.length]!,
    predicate: PREDICATES[(i * 3) % PREDICATES.length]!,
    object: OBJECTS[i % OBJECTS.length]!,
  }));
}

function entities(n: number, party: PartyMemberContext[]): SceneEntity[] {
  const out: SceneEntity[] = party.slice(0, Math.min(party.length, n)).map((p, i) => ({ id: p.id, kind: "character", name: p.name, x: 10 + i, y: 10 }));
  const kinds = ["npc", "enemy", "object", "enemy"];
  for (let i = out.length; i < n; i++) {
    const kind = kinds[i % kinds.length]!;
    out.push({
      id: `${kind}_${pad(i)}`, kind, name: `${kind === "enemy" ? "Reed Cultist" : kind === "npc" ? "Villager" : "Crate"} ${i}`, x: 4 + (i % 12), y: 3 + Math.floor(i / 12),
      ...(kind === "enemy" ? { hp: 12 - (i % 4) } : {}), ...(kind === "npc" ? { disposition: "wary" } : {}),
    });
  }
  return out;
}

function turns(n: number): DmContextPack["recentTurns"] {
  return Array.from({ length: n }, (_, i) =>
    i % 2 === 0
      ? { speaker: "DM", text: TURN_DM[(i / 2) % TURN_DM.length]!, kind: "dm" as const }
      : { speaker: NAMES[(i >> 1) % 4]!, text: TURN_PLAYER[(i >> 1) % TURN_PLAYER.length]!, kind: "player" as const },
  );
}

const PACING: PacingContext = {
  patternName: "Mystery in the Marsh", arcName: "Rising dread", stageIndex: 1, stageCount: 5, finished: false,
  stage: { id: "st_2", name: "Complication", title: "The ledger surfaces", goal: "Learn who in Hollowmere pays the cult and why Edda Marrow was taken.", purpose: "Raise the stakes and turn a rumor into a threat." },
  next: { id: "st_3", name: "Descent", title: "Into the sunken chapel", goal: "Reach the chapel before the next tide." },
  tension: 6, difficulty: "moderate", trendText: "fortune favors the bold, but the marsh is watching", openMilestones: 2,
};

const growth = (party: PartyMemberContext[]) => Object.fromEntries(party.map((p) => [p.id, 40]));

function pack(o: {
  players: number; abilities: number; items: number; turns: number; facts: number; entities: number; quests: number; milestones: number;
  summaries: number; cast: number; pacing: boolean; engineLines: string[];
}): DmContextPack {
  const base = makeLanternPack([
    { characterId: "ch_brindle", characterName: "Brindle Ash", text: TURN_PLAYER[2]! },
    { characterId: "ch_tamsin", characterName: "Tamsin Quickfoot", text: TURN_PLAYER[1]! },
  ]);
  const party = Array.from({ length: o.players }, (_, i) => member(i, o.abilities, o.items));
  return {
    ...base,
    summaries: Array.from({ length: o.summaries }, (_, i) => `Session part ${i + 1}: the party arrived in Hollowmere, questioned the innkeeper, found the marsh path flooded, and recovered a clue pointing to the Reed Court. Odalys Brand agreed to hide them for a night in exchange for a favor still unnamed.`),
    facts: facts(o.facts),
    scene: { ...base.scene, entities: entities(o.entities, party) },
    party,
    quests: Array.from({ length: o.quests }, (_, i) => ({ id: `q_${i + 1}`, title: ["Find Edda Marrow", "Silence the bell", "Pay the ferryman"][i % 3]!, status: "active", notes: ["Last seen on the causeway.", "Odalys knows more than she says."].slice(0, i % 3) })),
    milestones: Array.from({ length: o.milestones }, (_, i) => ({ id: `ms_${i + 1}`, stage: `st_${(i % 3) + 1}`, completed: i < 2, description: `The party ${["learns the cult's name", "finds the ledger", "crosses the causeway", "frees a captive", "earns Odalys's trust", "reaches the chapel"][i % 6]!}.` })),
    pacing: o.pacing ? PACING : undefined,
    recentTurns: turns(o.turns),
    engineLines: o.engineLines,
    partyLevel: 3,
    lootRemaining: 45,
    growthRemaining: growth(party),
    ...(o.cast ? { cast: Array.from({ length: o.cast }, (_, i) => ({ assetId: `as_${pad(i)}`, name: `Cast ${i}`, kind: i % 2 ? ("enemy" as const) : ("npc" as const), concept: "a gaunt marsh-priest in a patched green cloak, carrying a lantern that burns blue" })) } : {}),
  };
}

export const CONTEXT_PACKS: Record<"opening" | "typical" | "heavy", DmContextPack> = {
  opening: { ...makeLanternPack([{ characterId: "ch_brindle", characterName: "Brindle Ash", text: "I look around the square." }]), growthRemaining: { ch_brindle: 50, ch_tamsin: 50, ch_orrin: 50 } },
  typical: pack({
    players: 4, abilities: 4, items: 6, turns: 8, facts: 12, entities: 6, quests: 3, milestones: 6, summaries: 1, cast: 0, pacing: true,
    engineLines: ["[engine: Brindle rolled 14 + 3 against DC 12, success]", "[engine: Reed Cultist 01 takes 7 fire damage, hp 5/12]"],
  }),
  heavy: pack({
    players: 6, abilities: 4, items: 6, turns: 12, facts: 30, entities: 25, quests: 3, milestones: 6, summaries: 6, cast: 10, pacing: true,
    engineLines: ["[engine: Brindle rolled 14 + 3 against DC 12, success]", "[engine: Reed Cultist 01 takes 7 fire damage, hp 5/12]"],
  }),
};
