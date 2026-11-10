/** Shared fixtures for engine tests. Not exported from the package. */
import { fixtures, type Enemy, type GameMap, type StoryBible, type WorldFact } from "@aedm/schemas";
import { applyDmActions } from "./dm-actions.ts";
import { createRng, type Rng } from "./rng.ts";
import { addCharacter, addMap, createGameState, placePartyOnMap, registerArchetype, type GameState } from "./state.ts";

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

export function makeWorld(seed = 7, opts: { walls?: [number, number][]; bible?: StoryBible } = {}): { state: GameState; rng: Rng } {
  const rng = createRng(seed);
  let state = createGameState({ seed, bible: opts.bible ?? BIBLE, facts: FACTS, contentRating: "teen" });
  for (const c of fixtures.SPIKE_PARTY) {
    const r = addCharacter(state, c, c.user_id);
    if (!r.ok) throw new Error(r.errors.join("; "));
    state = r.state;
  }
  state = addMap(state, makeTestMap("m_lighthouse", opts.walls)).state;
  state = placePartyOnMap(state, "m_lighthouse").state;
  return { state, rng };
}

export function withArchetype(state: GameState, enemy: Enemy = chorister): { state: GameState; id: string } {
  const r = registerArchetype(state, enemy);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return { state: r.state, id: r.archetype.id as string };
}

export const PARTY_IDS = fixtures.SPIKE_PARTY.map((c) => c.id);

/** Spawn `count` of an archetype through the real DM action path. */
export function spawn(state: GameState, rng: Rng, archetypeId: string, x: number, y: number, count = 1): GameState {
  const r = applyDmActions(state, rng, [{ type: "spawn_entity", archetype_id: archetypeId, map_id: "m_lighthouse", x, y, count }], { presentCharacterIds: PARTY_IDS, partyLevel: 1 });
  if (r.rejected.length > 0) throw new Error(r.rejected.map((x) => x.reason).join("; "));
  return r.state;
}
