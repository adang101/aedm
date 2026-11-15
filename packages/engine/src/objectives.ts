/**
 * Objective tracking with no model call. The engine judges every machine-checkable milestone (see `MilestoneTrigger`) from
 * the game state and what just happened, completes the ones that are met in stage order, and reports what completed.
 * `story` milestones stay with the DM (`complete_milestone`). Pure and deterministic; growth awards reuse the DM action's code.
 */
import type { Milestone, MilestoneTrigger, ObjectiveMilestone, ObjectiveView } from "@aedm/schemas";
import { RULES } from "./data.ts";
import type { EngineEvent } from "./events.ts";
import { addGrowthM } from "./growth.ts";
import { isMachineTrigger, triggerOf } from "./campaign.ts";
import { isStanding } from "./mutate.ts";
import { milestoneHint, objectiveView } from "./objective-view.ts";
import { currentStage } from "./plot.ts";
import { fromState } from "./rng.ts";
import { campaignOf, emit, emptyCampaignBinding, run, type GameState, type Mut, type Result } from "./state.ts";

const norm = (s: string) => s.trim().toLowerCase();

// ---------- completing a milestone (shared with the DM action) ----------

/**
 * Mark a milestone complete: emits `milestone_completed`, `stage_advanced` when it was the last open one of its stage, and
 * gives each present character the milestone growth award. The caller has already checked that it may complete.
 */
export function completeMilestoneM(m: Mut, ms: Milestone, presentIds: readonly string[]): void {
  const s = m.s;
  const before = currentStage(s.bible);
  ms.completed = true;
  emit(m, { type: "milestone_completed", milestoneId: ms.id, description: ms.description });
  const after = currentStage(s.bible);
  if (before && after && !before.finished && after.index > before.index) {
    emit(m, { type: "stage_advanced", stageId: after.stage.id, stageName: after.data.name, title: after.stage.title });
  }
  for (const id of presentIds) {
    const c = s.characters[id];
    if (!c) continue;
    addGrowthM(m, id, RULES.growth.milestoneAward);
    emit(m, { type: "growth_awarded", characterId: id, name: c.name, amount: RULES.growth.milestoneAward, reason: "milestone", growth: c.growth });
  }
}

// ---------- judging a trigger ----------

function holdsKeyItem(s: GameState, itemId: string): boolean {
  const runtimeId = campaignOf(s).items[itemId];
  const planName = s.bible.key_items?.find((k) => k.id === itemId)?.name;
  return Object.values(s.characters).some((c) =>
    c.inventory.some((i) => (runtimeId !== undefined && i.id === runtimeId) || (i.kind === "quest" && planName !== undefined && norm(i.name) === norm(planName))));
}

/** A creature of an encounter is dealt with when it is gone (defeated, fled), down, or no longer hostile (surrendered). */
function dealtWith(s: GameState, entityId: string): boolean {
  const e = s.entities[entityId];
  return !e || !isStanding(e) || e.disposition !== "hostile";
}

/** True when the state meets a machine-checkable trigger. `story` is never met by the engine. */
export function triggerSatisfied(s: GameState, t: MilestoneTrigger): boolean {
  const b = campaignOf(s);
  switch (t.type) {
    case "reach_location": return b.visited.includes(t.location);
    case "talk_to": return b.talked.includes(t.cast);
    case "obtain_item": return holdsKeyItem(s, t.item);
    case "defeat_encounter": {
      const e = b.encounters[t.encounter];
      return !!e && e.entityIds.length > 0 && e.entityIds.every((id) => dealtWith(s, id));
    }
    case "story": return false;
  }
}

/**
 * Why a machine-checkable trigger can no longer be met, or undefined. Used to let the DM complete a milestone the engine
 * can no longer track (a dead cast member, an item nobody can reach). Content that is not built yet is never blocked.
 */
export function triggerBlocked(s: GameState, t: MilestoneTrigger): string | undefined {
  const b = campaignOf(s);
  switch (t.type) {
    case "talk_to": {
      const id = b.cast[t.cast];
      const rec = id ? s.npcs[id] : undefined;
      return rec && rec.alive === false && !b.talked.includes(t.cast) ? `${rec.name} is dead` : undefined;
    }
    case "defeat_encounter": {
      const e = b.encounters[t.encounter];
      return e && e.entityIds.length === 0 ? "no creatures were placed for that encounter" : undefined;
    }
    case "obtain_item": {
      const id = b.items[t.item];
      if (id === undefined || holdsKeyItem(s, t.item)) return undefined;
      const reachable = Object.values(s.containers).some((c) => c.items.some((i) => i.id === id) && (c.kind !== "pockets" || (!!c.owner_entity_id && !!s.entities[c.owner_entity_id])));
      return reachable ? undefined : "nobody holds the item and it is not lying anywhere";
    }
    case "reach_location":
    case "story": return undefined;
  }
}

// ---------- tracking ----------

export interface ObjectiveInput {
  /** What just happened (the events of the call): `scene_changed` marks a place visited, `npc_said` counts as talking to that NPC. */
  events?: readonly EngineEvent[];
  /** Entity ids the party just talked to (the targets of `talk` acts). */
  talkedTo?: readonly string[];
  /** Who shares the growth award. Default: every character standing on the current map. */
  presentCharacterIds?: readonly string[];
}

export interface ObjectiveProgress {
  /** Milestones completed by this call, in order. */
  completed: ObjectiveMilestone[];
  /** Player-facing lines for the log ("Objective complete: ..."). */
  lines: string[];
  /** The view after the call; null for a bible without a plot. */
  objective: ObjectiveView | null;
  /** True when the call moved the story to a new stage. */
  stageAdvanced: boolean;
}

/**
 * Remember where the party has been and whom it has talked to, then complete every open milestone of the current stage
 * whose trigger is met, repeating while a finished stage opens the next (stage order is never skipped). Returns the new state
 * (the same object when the bible has no machine-checkable milestones), the engine events (`milestone_completed`,
 * `stage_advanced`, `growth_awarded`, `level_up`) and a summary. Safe to call after every beat, scene change, defeat, pickup or `talk`.
 */
export function trackObjectives(state: GameState, input: ObjectiveInput = {}): Result<ObjectiveProgress> {
  const none: ObjectiveProgress = { completed: [], lines: [], objective: objectiveView(state), stageAdvanced: false };
  if (!state.bible.milestones.some((m) => isMachineTrigger(triggerOf(m)))) return { state, events: [], value: none };
  return run(state, fromState(state.rngState), (m) => {
    const s = m.s;
    const b = (s.campaign ??= emptyCampaignBinding());
    const note = (list: string[], id: string | undefined) => { if (id !== undefined && !list.includes(id)) list.push(id); };
    const planOf = (map: Record<string, string>, runtimeId: string) => Object.keys(map).find((k) => map[k] === runtimeId);

    note(b.visited, s.currentMapId ? planOf(b.locations, s.currentMapId) : undefined);
    for (const e of input.events ?? []) {
      if (e.type === "scene_changed") note(b.visited, planOf(b.locations, e.mapId));
      if (e.type === "npc_said") note(b.talked, planOf(b.cast, e.entityId));
    }
    for (const id of input.talkedTo ?? []) note(b.talked, planOf(b.cast, id));

    const present = input.presentCharacterIds ?? Object.values(s.characters)
      .filter((c) => s.entities[c.id]?.mapId === s.currentMapId && !s.absentEntityIds.includes(c.id))
      .map((c) => c.id);
    const completed: Milestone[] = [];
    let stageAdvanced = false;
    for (let guard = 0; guard < s.bible.milestones.length + 1; guard++) {
      const cur = currentStage(s.bible);
      if (!cur || cur.finished) break;
      const met = s.bible.milestones.filter((x) => !x.completed && x.stage === cur.stage.id && isMachineTrigger(triggerOf(x)) && triggerSatisfied(s, triggerOf(x)));
      if (met.length === 0) break;
      for (const ms of met) {
        completeMilestoneM(m, ms, present);
        completed.push(ms);
      }
      if ((currentStage(s.bible)?.index ?? 0) > cur.index) stageAdvanced = true;
    }
    const objective = objectiveView(s);
    const lines = completed.map((ms) => `Objective complete: ${milestoneHint(s.bible, ms)}`);
    if (stageAdvanced && objective && !objective.finished) lines.push(`New stage: ${objective.stage.title}. ${objective.stage.goal}`);
    if (completed.length > 0 && objective?.finished) lines.push("The campaign's goal is reached.");
    return {
      completed: completed.map((ms) => ({ id: ms.id, hint: milestoneHint(s.bible, ms), done: true })),
      lines, objective, stageAdvanced,
    } satisfies ObjectiveProgress;
  });
}
