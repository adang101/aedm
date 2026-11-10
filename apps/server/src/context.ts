import type { DmContextPack, SceneEntity } from "@aedm/llm";
import {
  MATERIAL_IDS, RULES, computePartyLevel, currentMap, entitiesOnMap, getObjects, lootCap, pacingBlock, type GameState,
} from "@aedm/engine";

export interface RecentTurn {
  speaker: string;
  text: string;
  kind: "player" | "dm";
  channel?: "ic" | "ooc";
}

export interface ContextInput {
  state: GameState;
  /** characterId -> owning player's display name and whether they are at the table. */
  players: Record<string, { name: string; present: boolean }>;
  intents: { characterId: string; characterName: string; text: string }[];
  engineLines?: string[];
  recentTurns?: RecentTurn[];
  summaries?: string[];
  linesAndVeils?: string;
  sceneNote?: string;
  /** Max recent turns handed to the DM (default 12). */
  recentLimit?: number;
  /** Usable cast entries (approved, npc or enemy). Listed to the DM by id, name, kind and a short concept. */
  cast?: { assetId: string; name: string; roleHint: string; concept: string }[];
}

const MAX_CAST_LISTED = 20;

const MAX_SCENE_ENTITIES = 40;

/** Characters that count as present for checks, growth and loot: those whose player is at the table. */
export function presentCharacterIds(state: GameState, players: ContextInput["players"]): string[] {
  const all = Object.keys(state.characters);
  const present = all.filter((id) => players[id]?.present !== false && state.entities[id]);
  return present.length > 0 ? present : all.filter((id) => state.entities[id]);
}

function sideOf(map: { width: number; height: number }, x: number, y: number): string | undefined {
  if (y === 0) return "north";
  if (y === map.height - 1) return "south";
  if (x === 0) return "west";
  if (x === map.width - 1) return "east";
  return undefined;
}

/** Pure: game state plus this beat's inputs become the DM's context pack. */
export function buildContextPack(input: ContextInput): DmContextPack {
  const { state } = input;
  const map = currentMap(state);
  const present = presentCharacterIds(state, input.players);
  const partyLevel = computePartyLevel(state, present);

  const entities: SceneEntity[] = [];
  const exits: DmContextPack["scene"]["exits"] = [];
  if (map) {
    for (const e of entitiesOnMap(state, map.id)) {
      entities.push({
        id: e.id,
        kind: e.kind === "pc" ? "character" : e.kind,
        name: e.name,
        x: e.x,
        y: e.y,
        hp: e.hp,
        ...(e.disposition ? { disposition: e.disposition } : {}),
      });
    }
    for (const o of getObjects(map)) {
      if (o.type === "interactable") {
        entities.push({ id: o.id, kind: "object", name: `${o.kind} (${o.state})`, x: o.x, y: o.y });
      } else if (o.type === "exit") {
        const side = sideOf(map, o.x, o.y);
        exits.push({ label: o.name, ...(side ? { side } : {}), ...(o.to !== "pending" ? { to: o.to } : {}) });
      }
    }
  }

  const party = Object.values(state.characters).map((c) => {
    const ent = state.entities[c.id];
    const info = input.players[c.id];
    return {
      id: c.id,
      name: c.name,
      title: c.title,
      level: c.level,
      hp: ent?.hp ?? c.hp,
      hpMax: ent?.hpMax ?? c.hp_max,
      tags: [...c.trait_tags],
      abilities: c.abilities.map((a) => a.name),
      inventory: c.inventory.map((i) => `${i.name} (${i.kind})`),
      playerName: info?.name ?? "unknown",
      present: present.includes(c.id),
    };
  });

  const growthRemaining: Record<string, number> = {};
  for (const id of present) {
    const rec = state.session.growthAwarded[id] ?? { points: 0, count: 0 };
    growthRemaining[id] = rec.count >= RULES.growth.sessionAwardCap ? 0 : Math.max(0, RULES.growth.sessionPointCap - rec.points);
  }

  const limit = input.recentLimit ?? 12;
  const recent = (input.recentTurns ?? []).filter((t) => t.channel !== "ooc").slice(-limit);

  return {
    materialIds: MATERIAL_IDS,
    storyDigest: `${state.bible.digest} Tone: ${state.bible.tone}`,
    contentRating: state.contentRating,
    linesAndVeils: input.linesAndVeils ?? "",
    summaries: input.summaries ?? [],
    facts: state.facts.map((f) => ({ ...f })),
    scene: {
      mapId: map?.id ?? "none",
      setting: map?.meta.setting.name ?? "Unknown place",
      description: input.sceneNote ?? (map ? `${map.meta.setting.name}.` : "Nowhere yet."),
      entities: entities.slice(0, MAX_SCENE_ENTITIES),
      exits,
    },
    party,
    quests: state.bible.quests.map((q) => ({ id: q.id, title: q.title, status: q.status, notes: [...q.notes] })),
    milestones: state.bible.milestones.map((m) => ({ id: m.id, description: m.description, completed: m.completed, ...(m.stage ? { stage: m.stage } : {}) })),
    pacing: pacingBlock(state.bible) ?? undefined,
    recentTurns: recent.map((t) => ({ speaker: t.speaker, text: t.text, kind: t.kind, channel: t.channel ?? "ic" })),
    engineLines: [...(input.engineLines ?? [])],
    intents: input.intents.map((i) => ({ ...i })),
    partyLevel,
    lootRemaining: Math.max(0, lootCap(partyLevel) - state.session.lootValueThisEncounter),
    growthRemaining,
    ...(input.cast?.length ? {
      cast: input.cast.filter((c) => c.roleHint === "npc" || c.roleHint === "enemy").slice(0, MAX_CAST_LISTED).map((c) => ({
        assetId: c.assetId, name: c.name, kind: c.roleHint as "npc" | "enemy", concept: c.concept.slice(0, 120),
      })),
    } : {}),
  };
}
