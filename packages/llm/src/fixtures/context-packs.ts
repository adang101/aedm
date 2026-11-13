import type { WorldFact } from "@aedm/schemas";
import type { DmContextPack, PartyMemberContext, PacingContext, SceneContainer, SceneEntity, SceneObject } from "../context";
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

const CONTAINER_ITEMS = ["Brass key", "Silver ring", "Healing draught", "Bent dagger"];

/** Chests (locked, closed, opened), piles and remains, nearest first. */
function containers(n: number): SceneContainer[] {
  return Array.from({ length: n }, (_, i): SceneContainer => {
    const x = 3 + i;
    const y = 4 + (i % 3);
    switch (i % 4) {
      case 0: return { id: `cn_${10 + i}`, kind: "chest", x, y, locked: 12, open: false, itemCount: 2 };
      case 1: return { id: `cn_${10 + i}`, kind: "chest", x, y, open: true, itemCount: 3, items: CONTAINER_ITEMS.slice(0, 3) };
      case 2: return { id: `cn_${10 + i}`, kind: "remains", label: "Reed Cultist", x, y, open: true, itemCount: 2 };
      default: return { id: `cn_${10 + i}`, kind: "pile", x, y, open: true, itemCount: 1 };
    }
  });
}

function objects(n: number): SceneObject[] {
  const kinds: [string, string][] = [["door", "closed"], ["sign", "closed"], ["lever", "closed"], ["door", "locked"], ["door", "open"], ["altar", "closed"]];
  return Array.from({ length: n }, (_, i) => {
    const [kind, state] = kinds[i % kinds.length]!;
    return { id: `${kind}_${i + 1}`, kind: kind!, x: 2 + i, y: 3, state: state!, ...(state === "locked" ? { dc: 12 } : {}) };
  });
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
  act: { index: 1, count: 3, act: { title: "The Drowned Bell", goal: "Find out who rings the bell beneath the marsh." } },
};

const growth = (party: PartyMemberContext[]) => Object.fromEntries(party.map((p) => [p.id, 40]));

function pack(o: {
  players: number; abilities: number; items: number; turns: number; facts: number; entities: number; quests: number; milestones: number;
  summaries: number; notes: number; npcs: number; threads: number; cast: number; pacing: boolean; engineLines: string[];
  containers?: number; objects?: number;
}): DmContextPack {
  const base = makeLanternPack([
    { characterId: "ch_brindle", characterName: "Brindle Ash", text: TURN_PLAYER[2]! },
    { characterId: "ch_tamsin", characterName: "Tamsin Quickfoot", text: TURN_PLAYER[1]! },
  ]);
  const party = Array.from({ length: o.players }, (_, i) => member(i, o.abilities, o.items));
  return {
    ...base,
    storySoFar: o.summaries > 0 ? "The party arrived in Hollowmere, questioned the innkeeper, found the marsh path flooded, and recovered a clue pointing to the Reed Court. Odalys Brand agreed to hide them for a night in exchange for a favor still unnamed. A bell rang under the water at midnight." : "",
    chapters: Array.from({ length: Math.min(4, Math.max(0, o.summaries - 1)) }, (_, i) => `Chapter ${i + 1}: the party crossed the causeway at low tide, bargained with the ferryman for passage, and found a ledger of payments signed with a heron sigil. Tamsin kept the ledger; Brindle suspects Odalys.`),
    dmNotes: Array.from({ length: o.notes }, (_, i) => ["The ferryman is the cult's courier.", "Odalys owes the Reed Court a debt; she will lie once about the ledger.", "The bell rings when someone drowns in the chapel."][i % 3]!),
    npcs: Array.from({ length: o.npcs }, (_, i) => ({
      id: `npc_${i + 1}`, name: ["Odalys Brand", "Pell the Ferryman", "Edda Marrow", "Sister Wren"][i % 4]!, role: ["quest_giver", "merchant", "bystander", "villain"][i % 4]!,
      disposition: ["friendly", "wary", "neutral", "hostile"][i % 4]!, alive: i % 7 !== 6, mapId: i % 2 === 0 ? "m_hollowmere" : "m_marsh", here: i % 2 === 0,
      concept: "A marsh local with a secret tied to the drowned bell.", voice: "low, careful, answers questions with questions",
      lines: ["Mind the humming after dark.", "The tide waits for no one."], notes: ["Promised the party a boat at dawn."],
    })),
    threads: Array.from({ length: o.threads }, (_, i) => ({ id: `th_${i + 1}`, text: ["Who lit the beacon on the drowned lighthouse?", "What does the heron sigil mean?", "Where was Edda Marrow taken?"][i % 3]! })),
    facts: facts(o.facts),
    scene: {
      ...base.scene, entities: entities(o.entities, party),
      ...(o.containers ? { containers: containers(o.containers) } : {}), ...(o.objects ? { objects: objects(o.objects) } : {}),
    },
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
    players: 4, abilities: 4, items: 6, turns: 8, facts: 12, entities: 6, quests: 3, milestones: 6, summaries: 1, notes: 3, npcs: 4, threads: 2, cast: 0, pacing: true, containers: 4, objects: 4,
    engineLines: ["[engine: Brindle rolled 14 + 3 against DC 12, success]", "[engine: Reed Cultist 01 takes 7 fire damage, hp 5/12]"],
  }),
  heavy: pack({
    players: 6, abilities: 4, items: 6, turns: 12, facts: 30, entities: 25, quests: 3, milestones: 6, summaries: 6, notes: 8, npcs: 12, threads: 6, cast: 10, pacing: true, containers: 10, objects: 12,
    engineLines: ["[engine: Brindle rolled 14 + 3 against DC 12, success]", "[engine: Reed Cultist 01 takes 7 fire damage, hp 5/12]"],
  }),
};
