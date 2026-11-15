import type { CombatContext, DmContextPack, NpcDossierEntry, ObjectiveContext, SceneContainer, SceneEntity, SceneObject } from "@aedm/llm";
import type { MilestoneTrigger, NpcRecord } from "@aedm/schemas";
import {
  MATERIAL_IDS, RULES, campaignOf, computePartyLevel, currentAct, currentMap, currentStage, effectiveLock, effectiveState, entitiesOnMap, getObjects,
  hasCampaignPlan, isContainerHidden, isHidden, isMachineTrigger, locationExits, lootCap, milestoneHint, pacingBlock, sideOf as combatSide, triggerBlocked, triggerOf, triggerSatisfied,
  type GameState,
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
  /** Compact summary of everything older than the chapters. */
  storySoFar?: string;
  /** Summaries of the most recent stretches of play, oldest first. */
  chapters?: string[];
  /** The DM's recent private notes, oldest first. */
  dmNotes?: string[];
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

/** The NPC dossier: those on the current map first, then the most recently seen; the living before the dead; at most `dossierMax`. */
function npcDossier(state: GameState): NpcDossierEntry[] {
  const here = (n: NpcRecord) => n.alive !== false && n.map_id === state.currentMapId;
  const group = (n: NpcRecord) => (n.alive === false ? 2 : here(n) ? 0 : 1);
  return Object.values(state.npcs)
    .sort((a, b) => group(a) - group(b) || (b.last_seen_beat ?? -1) - (a.last_seen_beat ?? -1))
    .slice(0, RULES.npc.dossierMax)
    .map((n) => ({
      id: n.id, name: n.name, role: n.role, disposition: n.disposition, alive: n.alive !== false, mapId: n.map_id, here: here(n),
      concept: n.concept, voice: n.voice, lines: n.lines ?? [], notes: n.notes ?? [],
      hp: n.role === "ally" && state.entities[n.id] ? { hp: state.entities[n.id]!.hp, hpMax: state.entities[n.id]!.hpMax } : undefined,
    }));
}

const COMBAT_CONCEPT_MAX = 100;

/** The fight in progress for the DM: initiative order with sides, HP, conditions and, for enemies, role, concept, behavior and morale. */
function combatBlock(state: GameState): CombatContext | undefined {
  const c = state.combat;
  if (!c) return undefined;
  return {
    round: c.round,
    activeId: c.active_id,
    order: c.order.flatMap((o) => {
      const e = state.entities[o.entity_id];
      if (!e) return [];
      const a = e.kind === "enemy" ? state.archetypes[e.refId] : undefined;
      return [{
        id: e.id, name: e.name, side: combatSide(e), hp: e.hp, hpMax: e.hpMax, conditions: e.conditions.map((x) => x.condition),
        ...(a ? { role: a.role, concept: a.concept.slice(0, COMBAT_CONCEPT_MAX), behavior: a.behavior } : {}),
        ...(e.morale ? { morale: e.morale } : {}),
        ...(e.bloodied ? { bloodied: true } : {}),
      }];
    }),
  };
}

/**
 * The campaign plan for this beat: the open milestones of the current stage (and whether the engine or the DM completes
 * each), the ending, and the plan's facts for the place the party is in now. Only the current stage and place, never the
 * whole plan. Undefined when the bible has no plot or no plan (older saves), so those keep the plain milestone list.
 */
export function objectiveContext(state: GameState): ObjectiveContext | undefined {
  const bible = state.bible;
  const cur = currentStage(bible);
  if (!cur || !hasCampaignPlan(bible) || !bible.ending) return undefined;
  const bound = campaignOf(state);
  const place = (id: string | undefined) => bible.locations?.find((l) => l.id === id)?.name;
  const targetOf = (t: MilestoneTrigger): string | undefined => {
    switch (t.type) {
      case "reach_location": return place(t.location);
      case "talk_to": { const c = bible.cast?.find((x) => x.id === t.cast); return c ? `${c.name} at ${place(c.location)}` : undefined; }
      case "obtain_item": { const k = bible.key_items?.find((x) => x.id === t.item); return k ? `${k.name} at ${place(k.location)}` : undefined; }
      case "defeat_encounter": { const e = bible.encounters?.find((x) => x.id === t.encounter); return e ? `${e.name} at ${place(e.location)}` : undefined; }
      case "story": return undefined;
    }
  };
  const open = bible.milestones.filter((m) => m.stage === cur.stage.id && !m.completed).map((m) => {
    const t = triggerOf(m);
    const target = targetOf(t);
    return {
      id: m.id, hint: milestoneHint(bible, m), who: isMachineTrigger(t) && triggerBlocked(state, t) === undefined ? ("engine" as const) : ("dm" as const),
      ...(target ? { target } : {}),
    };
  });

  const locId = Object.keys(bound.locations).find((id) => bound.locations[id] === state.currentMapId);
  const loc = locId ? bible.locations?.find((l) => l.id === locId) : undefined;
  const here: ObjectiveContext["here"] = loc && {
    name: loc.name,
    summary: loc.summary,
    cast: (bible.cast ?? []).filter((c) => c.location === loc.id && state.npcs[bound.cast[c.id] ?? ""]?.alive !== false).map((c) => ({ name: c.name, role: c.role })),
    fights: (bible.encounters ?? []).filter((e) => e.location === loc.id).map((e) => ({ name: e.name, done: triggerSatisfied(state, { type: "defeat_encounter", encounter: e.id }) })),
    items: (bible.key_items ?? []).filter((k) => k.location === loc.id && !triggerSatisfied(state, { type: "obtain_item", item: k.id })).map((k) => {
      const holder = k.held_by && (k.held_by.kind === "cast" ? bible.cast?.find((c) => c.id === k.held_by!.id)?.name : bible.encounters?.find((e) => e.id === k.held_by!.id)?.name);
      return { name: k.name, ...(holder ? { heldBy: holder } : {}) };
    }),
    exits: locationExits(bible, loc.id).map((x) => ({ label: x.label, to: place(x.to) ?? x.to, been: bound.visited.includes(x.to) })),
  };
  return {
    open, ending: { goal: bible.ending.goal, success: bible.ending.success }, finished: cur.finished,
    ...(here ? { here } : {}),
  };
}

/** Pure: game state plus this beat's inputs become the DM's context pack. */
export function buildContextPack(input: ContextInput): DmContextPack {
  const { state } = input;
  const map = currentMap(state);
  const present = presentCharacterIds(state, input.players);
  const partyLevel = computePartyLevel(state, present);

  const entities: SceneEntity[] = [];
  const exits: DmContextPack["scene"]["exits"] = [];
  const objects: SceneObject[] = [];
  const containers: SceneContainer[] = [];
  if (map) {
    for (const e of entitiesOnMap(state, map.id)) {
      entities.push({
        id: e.id,
        kind: e.kind === "pc" ? "character" : e.kind,
        name: e.name,
        x: e.x,
        y: e.y,
        hp: e.hp,
        hpMax: e.hpMax,
        ...(e.disposition ? { disposition: e.disposition } : {}),
      });
    }
    for (const o of getObjects(map)) {
      if (o.type === "interactable") {
        if (o.kind === "chest") continue; // listed once, as its container
        const st = effectiveState(state, map.id, o);
        const lock = st === "locked" ? effectiveLock(state, map.id, o) : undefined;
        objects.push({ id: o.id, kind: o.kind, x: o.x, y: o.y, state: st, ...(lock ? { dc: lock.dc } : {}), ...(isHidden(state, map.id, o) ? { hidden: true } : {}) });
      } else if (o.type === "exit") {
        const side = sideOf(map, o.x, o.y);
        exits.push({ label: o.name, ...(side ? { side } : {}), ...(o.to !== "pending" ? { to: o.to } : {}) });
      }
    }
  }

  if (map) {
    const reach = (c: { x: number; y: number }): number => {
      const ds = Object.keys(state.characters).flatMap((id) => {
        const e = state.entities[id];
        return e && e.mapId === map.id ? [Math.max(Math.abs(e.x - c.x), Math.abs(e.y - c.y))] : [];
      });
      return ds.length ? Math.min(...ds) : 99;
    };
    const visible = Object.values(state.containers).filter((c) => c.map_id === map.id && c.kind !== "pockets" && (c.kind === "chest" || c.items.length > 0));
    for (const c of visible.sort((a, b) => reach(a) - reach(b) || a.id.localeCompare(b.id))) {
      const opened = c.kind === "chest" && c.opened === true && !c.locked;
      containers.push({
        id: c.id, kind: c.kind as SceneContainer["kind"], x: c.x, y: c.y, open: c.kind === "chest" ? c.opened === true : true, itemCount: c.items.length,
        ...(c.kind === "remains" && c.label ? { label: c.label.replace(/^Remains of /, "") } : {}),
        ...(c.locked ? { locked: c.lock?.dc ?? 10 } : {}),
        ...(isContainerHidden(state, c) ? { hidden: true } : {}),
        ...(opened ? { items: c.items.map((i) => i.name) } : {}),
      });
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

  const pacing = pacingBlock(state.bible) ?? undefined;
  const objective = objectiveContext(state);
  const limit = input.recentLimit ?? 12;
  const recent = (input.recentTurns ?? []).filter((t) => t.channel !== "ooc").slice(-limit);

  return {
    materialIds: MATERIAL_IDS,
    storyDigest: `${state.bible.digest} Tone: ${state.bible.tone}`,
    contentRating: state.contentRating,
    linesAndVeils: input.linesAndVeils ?? "",
    storySoFar: input.storySoFar ?? "",
    chapters: input.chapters ?? [],
    dmNotes: input.dmNotes ?? [],
    act: pacing ? undefined : currentAct(state.bible) ?? undefined,
    combat: combatBlock(state),
    npcs: npcDossier(state),
    threads: state.threads.filter((t) => t.status === "open").map((t) => ({ id: t.id, text: t.text })),
    facts: state.facts.map((f) => ({ ...f })),
    scene: {
      mapId: map?.id ?? "none",
      setting: map?.meta.setting.name ?? "Unknown place",
      description: input.sceneNote ?? (map ? `${map.meta.setting.name}.` : "Nowhere yet."),
      entities: entities.slice(0, MAX_SCENE_ENTITIES),
      exits,
      ...(containers.length ? { containers } : {}),
      ...(objects.length ? { objects } : {}),
    },
    party,
    quests: state.bible.quests.map((q) => ({ id: q.id, title: q.title, status: q.status, notes: [...q.notes] })),
    milestones: state.bible.milestones.map((m) => ({ id: m.id, description: m.description, completed: m.completed, ...(m.stage ? { stage: m.stage } : {}) })),
    pacing,
    ...(objective ? { objective } : {}),
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
