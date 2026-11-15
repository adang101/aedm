/** Shared fixtures for engine tests. Not exported from the package. */
import { fixtures, type Enemy, type GameMap, type MapObject, type StoryBible, type WorldFact } from "@aedm/schemas";
import { applyDmActions } from "./dm-actions.ts";
import { createRng, type Rng } from "./rng.ts";
import { addMap } from "./map-state.ts";
import { addCharacter, cloneState, createGameState, placePartyOnMap, registerArchetype, type GameState } from "./state.ts";

export const BIBLE: StoryBible = {
  title: "The Lantern Marsh",
  digest: "A drowned coastal region where fog and tide hide old secrets.",
  tone: "eerie, grounded, a little wry",
  milestones: [
    { id: "m1", description: "The party learns the cult's name.", completed: false },
    { id: "m2", description: "The party finds the keeper.", completed: false },
  ],
  quests: [{ id: "q_edda", title: "Find Edda Marrow", status: "active", notes: [] }],
};

/** A bible with a tragedy / rise_fall plot: two milestones (m1..m10) in each of the five stages. */
export const PLOT_BIBLE: StoryBible = (() => {
  const stages = ["anticipation", "dream", "frustration", "nightmare", "downfall"];
  return {
    ...BIBLE,
    plot: { pattern: "tragedy", arc: "rise_fall", stages: stages.map((id) => ({ id, title: id, goal: `Goal of ${id}.` })) },
    milestones: stages.flatMap((stage, i) => [
      { id: `m${i * 2 + 1}`, description: `${stage} one`, completed: false, stage },
      { id: `m${i * 2 + 2}`, description: `${stage} two`, completed: false, stage },
    ]),
  };
})();

export const FACTS: WorldFact[] = [
  { subject: "Hollow Pell", predicate: "is_alive", object: "false" },
  { subject: "Odalys Brand", predicate: "disposition", object: "friendly" },
];

/** Open 20x20 map with optional wall tiles. */
export function makeTestMap(id = "m_lighthouse", walls: [number, number][] = []): GameMap {
  const map = structuredClone(fixtures.makeMap()) as unknown as GameMap;
  map.id = id;
  const layer = map.layers.find((l) => l.type === "tilelayer" && l.name === "walls");
  if (layer && layer.type === "tilelayer") for (const [x, y] of walls) layer.data[y * map.width + x] = 1;
  return map;
}

export const chorister: Enemy = {
  v: 1, name: "Robed Chorister", concept: "A cultist who borrows the voices of the drowned.", role: "standard",
  stats: { hp: 10, defense: 12, attack_bonus: 3, speed: 6, damage_dice: "1d6" },
  weakness: null, resistance: null, behavior: ["Closes to melee", "Sings at the weakest foe"],
  loot_hint: "", sprite_tags: ["robe"],
  abilities: [{
    v: 1, name: "Borrowed Voice", description: "Dazzles a target with a stolen voice.", tags: [], action: "action", target: "enemy",
    range_tiles: 6, cooldown_turns: 3,
    effects: [{ type: "condition", condition: "dazzled", duration_turns: 1, on: "failed_save", save: { ability: "wis", dc: "caster_dc" } }],
  }],
};

export function makeWorld(seed = 7, opts: { walls?: [number, number][]; bible?: StoryBible; objects?: MapObject[] } = {}): { state: GameState; rng: Rng } {
  const rng = createRng(seed);
  let state = createGameState({ seed, bible: opts.bible ?? BIBLE, facts: FACTS, contentRating: "teen" });
  for (const c of fixtures.SPIKE_PARTY) {
    const r = addCharacter(state, c, c.user_id);
    if (!r.ok) throw new Error(r.errors.join("; "));
    state = r.state;
  }
  const map = makeTestMap("m_lighthouse", opts.walls);
  const objects = map.layers.find((l) => l.type === "objectgroup");
  if (objects && objects.type === "objectgroup") objects.objects.push(...(opts.objects ?? []));
  state = addMap(state, map).state;
  state = placePartyOnMap(state, "m_lighthouse").state;
  return { state, rng };
}

export function withArchetype(state: GameState, enemy: Enemy = chorister): { state: GameState; id: string } {
  const r = registerArchetype(state, enemy);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return { state: r.state, id: r.archetype.id as string };
}

export const PARTY_IDS = fixtures.SPIKE_PARTY.map((c) => c.id);

/** Move a creature to a tile (a test shortcut: no path, no events). */
export function placeAt(state: GameState, id: string, x: number, y: number): GameState {
  const s = cloneState(state);
  const e = s.entities[id];
  if (!e) throw new Error(`no entity ${id}`);
  e.x = x;
  e.y = y;
  return s;
}

/** Copy the state, let `fn` change the copy, and return it. */
export function withState(state: GameState, fn: (s: GameState) => void): GameState {
  const s = cloneState(state);
  fn(s);
  return s;
}

/** Spawn `count` of an archetype through the real DM action path. */
export function spawn(state: GameState, rng: Rng, archetypeId: string, x: number, y: number, count = 1): GameState {
  const r = applyDmActions(state, rng, [{ type: "spawn_entity", archetype_id: archetypeId, map_id: "m_lighthouse", x, y, count }], { presentCharacterIds: PARTY_IDS, partyLevel: 1 });
  if (r.rejected.length > 0) throw new Error(r.rejected.map((x) => x.reason).join("; "));
  return r.state;
}

const SETTLEMENT = { name: "Hollowmere square", preset: "town", layout: "settlement", environment: "outdoor", mood: "neutral" } as const;
const MARSH = { name: "Marsh", preset: "swamp", layout: "open_field", environment: "outdoor", mood: "eerie" } as const;
const CRYPT = { name: "Drowned crypt", preset: "crypt", layout: "rooms_and_corridors", environment: "underground", mood: "dark" } as const;

/**
 * A bible with a hand-written campaign plan over the overcoming-the-monster pattern: five locations in a chain, two cast
 * members, two encounters, two key items and one milestone per stage (the third stage has a second, `story` one).
 */
export const CAMPAIGN_BIBLE: StoryBible = (() => {
  const stages = ["call", "early_success", "frustration", "nightmare", "final_confrontation"];
  return {
    ...BIBLE,
    plot: { pattern: "overcoming_the_monster", arc: "fall_rise", stages: stages.map((id) => ({ id, title: `Stage ${id}`, goal: `Goal of ${id}.` })) },
    locations: [
      { id: "l_square", name: "Hollowmere Square", summary: "A fogbound village square.", stage: "call", connects_to: ["l_dock"], setting: SETTLEMENT, features: ["well", "sign"] },
      { id: "l_dock", name: "The Rotting Dock", summary: "A pier where the ferry no longer runs.", stage: "early_success", connects_to: ["l_square", "l_marsh"], setting: { ...MARSH, name: "Dock", preset: "beach", layout: "trail" } },
      { id: "l_marsh", name: "Lantern Marsh", summary: "Reeds, fog and sleepwalkers.", stage: "frustration", connects_to: ["l_dock", "l_crypt"], setting: MARSH, theme_tags: ["marsh", "fog"] },
      { id: "l_crypt", name: "The Drowned Crypt", summary: "Where the Choir sings.", stage: "nightmare", connects_to: ["l_marsh", "l_lair"], setting: CRYPT },
      { id: "l_lair", name: "The Choir's Heart", summary: "The source of the voices.", stage: "final_confrontation", connects_to: ["l_crypt"], setting: { ...CRYPT, name: "Choir heart", layout: "arena" } },
    ],
    cast: [
      { id: "c_tam", name: "Old Tam", concept: "A ferryman who saw Edda leave.", role: "quest_giver", location: "l_square", voice: "gruff, nautical" },
      { id: "c_wren", name: "Wren Ashby", concept: "A marsh guide, wary of strangers.", role: "ally", location: "l_marsh" },
    ],
    encounters: [
      { id: "e_sentries", name: "Marsh sentries", location: "l_marsh", stage: "frustration", groups: [{ concept: "A cultist who borrows the voices of the drowned", role: "minion", count: 2 }, { concept: "A choir sentry in drowned robes", role: "standard", count: 1 }] },
      { id: "e_boss", name: "The Choirmaster", location: "l_lair", stage: "final_confrontation", groups: [{ concept: "The Choirmaster, who sings with a hundred borrowed voices", role: "boss", count: 1 }] },
    ],
    key_items: [
      { id: "k_lens", name: "Lantern Lens", location: "l_dock" },
      { id: "k_signet", name: "Choir Signet", location: "l_marsh", held_by: { kind: "cast", id: "c_wren" } },
    ],
    ending: { goal: "Silence the Quiet Choir.", success: "The sleepers wake.", failure: "The marsh keeps them." },
    milestones: [
      { id: "m1", description: "The party hears Tam's story.", completed: false, stage: "call", trigger: { type: "talk_to", cast: "c_tam" } },
      { id: "m2", description: "The party finds the lens.", completed: false, stage: "early_success", trigger: { type: "obtain_item", item: "k_lens" } },
      { id: "m3", description: "The party drives off the sentries.", completed: false, stage: "frustration", hint: "Clear the sentries from the marsh", trigger: { type: "defeat_encounter", encounter: "e_sentries" } },
      { id: "m4", description: "The party decides who to trust.", completed: false, stage: "frustration" },
      { id: "m5", description: "The party enters the crypt.", completed: false, stage: "nightmare", trigger: { type: "reach_location", location: "l_crypt" } },
      { id: "m6", description: "The party ends the Choir.", completed: false, stage: "final_confrontation", trigger: { type: "defeat_encounter", encounter: "e_boss" } },
    ],
  };
})();
