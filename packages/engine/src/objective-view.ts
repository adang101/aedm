/** The player-facing view of the story's progress, and the wording of objective hints. Pure; reads only the bible. */
import { HINT_MAX, type Milestone, type ObjectiveView, type StoryBible } from "@aedm/schemas";
import { currentStage } from "./plot.ts";
import { triggerOf } from "./campaign.ts";
import type { GameState } from "./state.ts";

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 3).trimEnd()}...`;
}

/**
 * The short imperative players see for a milestone: its own `hint`, else one derived from its trigger and the plan's
 * names ("Talk to Old Tam at Hollowmere Square"), else its description. Never longer than the wire limit.
 */
export function milestoneHint(bible: StoryBible, m: Milestone): string {
  if (m.hint) return clip(m.hint, HINT_MAX);
  const t = triggerOf(m);
  const place = (id: string | undefined) => bible.locations?.find((l) => l.id === id)?.name;
  let derived: string | undefined;
  switch (t.type) {
    case "reach_location": {
      const name = place(t.location);
      if (name) derived = `Go to ${name}`;
      break;
    }
    case "defeat_encounter": {
      const e = bible.encounters?.find((x) => x.id === t.encounter);
      if (e) derived = `Defeat ${e.name}${place(e.location) ? ` at ${place(e.location)}` : ""}`;
      break;
    }
    case "obtain_item": {
      const k = bible.key_items?.find((x) => x.id === t.item);
      if (k) derived = `Find the ${k.name}${place(k.location) ? ` at ${place(k.location)}` : ""}`;
      break;
    }
    case "talk_to": {
      const c = bible.cast?.find((x) => x.id === t.cast);
      if (c) derived = `Talk to ${c.name}${place(c.location) ? ` at ${place(c.location)}` : ""}`;
      break;
    }
    case "story": break;
  }
  return clip(derived ?? m.description, HINT_MAX);
}

/**
 * What the table sees of the story: the current stage (title, goal), that stage's milestones as `{ id, hint, done }`,
 * overall progress and whether the story is finished. Later stages and trigger internals never appear. Null when the
 * bible has no plot (older saves).
 */
export function objectiveView(state: Pick<GameState, "bible">): ObjectiveView | null {
  const bible = state.bible;
  const cur = currentStage(bible);
  if (!bible.plot || !cur) return null;
  return {
    stage: { id: cur.stage.id, index: cur.index, count: bible.plot.stages.length, title: cur.stage.title, goal: cur.stage.goal },
    milestones: bible.milestones
      .filter((m) => m.stage === cur.stage.id)
      .map((m) => ({ id: m.id, hint: milestoneHint(bible, m), done: m.completed })),
    progress: { done: bible.milestones.filter((m) => m.completed).length, total: bible.milestones.length },
    finished: cur.finished,
  };
}
