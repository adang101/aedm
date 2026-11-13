import { applyDmActions, rngFromState, startCombat, type GameState } from "@aedm/engine";
import { PARTY_IDS, makeWorld, spawn, withArchetype } from "@aedm/engine/testkit";
import type { Enemy, StoryBible, WorldFact } from "@aedm/schemas";
import { fixtures } from "@aedm/schemas";
import { buildContextPack, type ContextInput } from "@aedm/server/src/context";
import type { DmSetup } from "./types";

const MAP_ID = "m_lighthouse";

const PLAYERS: ContextInput["players"] = Object.fromEntries(
  fixtures.SPIKE_PARTY.map((c) => [c.id, { name: c.user_id.replace(/^u_/, ""), present: true }]),
);

export const BRINDLE = "ch_brindle";
export const TAMSIN = "ch_tamsin";
export const ORRIN = "ch_orrin";

const NAMES: Record<string, string> = Object.fromEntries(fixtures.SPIKE_PARTY.map((c) => [c.id, c.name]));

/** A player's in-character input for one beat. */
export const say = (characterId: string, text: string) => ({ characterId, characterName: NAMES[characterId] ?? characterId, text });

export interface NpcSpec {
  name: string;
  concept: string;
  role?: "merchant" | "quest_giver" | "ally" | "bystander" | "villain";
  x: number;
  y: number;
  voice?: string;
  /** Dossier notes, added through `npc_note`. */
  notes?: string[];
  /** Dead in the dossier only: no fact records it. */
  deadInDossier?: boolean;
}

/** Enemies standing in the room when the scenario starts with a fight already on. */
export interface FoeSpec {
  enemy: Enemy;
  at: [number, number];
  count?: number;
  /** Current HP of each spawned creature. */
  hp?: number;
  morale?: "held" | "broken";
  bloodied?: boolean;
}

export interface SetupOptions extends Partial<Omit<ContextInput, "state" | "players" | "intents">> {
  intents: ContextInput["intents"];
  facts?: WorldFact[];
  bible?: StoryBible;
  /** Name of the place the party is in. */
  setting?: string;
  npcs?: NpcSpec[];
  threads?: string[];
  /** Start with a fight on: the party, these enemies and any allied NPCs, standard difficulty. */
  fight?: FoeSpec[];
  /** For anything the options above do not cover. Runs last on the fresh state. */
  tweak?: (state: GameState) => void;
  buildEnemies?: boolean;
}

/** Applies engine actions during setup and fails loudly: a scenario that cannot be built is a bug in the scenario. */
function apply(state: GameState, actions: Parameters<typeof applyDmActions>[2]): GameState {
  const r = applyDmActions(state, rngFromState(state), actions, { presentCharacterIds: PARTY_IDS, partyLevel: 1 });
  if (r.rejected.length > 0) throw new Error(`eval setup: ${r.rejected.map((x) => x.reason).join("; ")}`);
  return r.state;
}

/** Spawns the foes through the real engine actions and starts combat with the party, the foes and the allies already in the room. */
function startFight(state: GameState, foes: FoeSpec[]): GameState {
  let s = state;
  for (const f of foes) {
    const a = withArchetype(s, f.enemy);
    s = spawn(a.state, rngFromState(a.state), a.id, f.at[0], f.at[1], f.count ?? 1);
    for (const e of Object.values(s.entities)) {
      if (e.kind !== "enemy" || e.refId !== a.id) continue;
      if (f.hp !== undefined) e.hp = f.hp;
      if (f.morale) e.morale = f.morale;
      if (f.bloodied) e.bloodied = true;
    }
  }
  const sides = Object.values(s.entities).filter((e) => e.kind === "enemy" || (e.kind === "npc" && s.npcs[e.refId]?.role === "ally"));
  const r = startCombat(s, rngFromState(s), [...PARTY_IDS, ...sides.map((e) => e.id)], "standard");
  if (!r.ok) throw new Error(`eval setup: ${r.error}`);
  return r.state;
}

/** The spike party at level 1 in an open room, plus whatever the options add through the real engine actions. */
export function buildDmSetup(opts: SetupOptions): DmSetup {
  let { state } = makeWorld(7, opts.bible ? { bible: opts.bible } : {});
  state.facts.push(...(opts.facts ?? []));
  if (opts.setting) state.maps[MAP_ID]!.meta.setting.name = opts.setting;

  for (const n of opts.npcs ?? []) {
    state = apply(state, [{
      type: "create_npc", name: n.name, concept: n.concept, role: n.role ?? "bystander", map_id: MAP_ID, x: n.x, y: n.y,
      sprite_tags: [], ...(n.voice ? { voice: n.voice } : {}),
    }]);
    const id = Object.values(state.npcs).find((r) => r.name === n.name)!.id;
    state = apply(state, (n.notes ?? []).map((note) => ({ type: "npc_note" as const, entity_id: id, note })));
    if (n.deadInDossier) {
      state.npcs[id]!.alive = false;
      delete state.entities[id];
      state.facts = state.facts.filter((f) => f.subject !== n.name);
    }
  }
  state = apply(state, (opts.threads ?? []).map((text) => ({ type: "open_thread" as const, text })));
  if (opts.fight) state = startFight(state, opts.fight);
  opts.tweak?.(state);

  const { intents, facts: _f, bible: _b, setting: _s, npcs: _n, threads: _t, fight: _g, tweak: _w, buildEnemies, ...extra } = opts;
  const pack = buildContextPack({ state, players: PLAYERS, intents, ...extra });
  return { state, pack, ...(buildEnemies ? { buildEnemies } : {}) };
}

