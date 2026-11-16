import type { ObjectiveView } from "@aedm/schemas";

export type Milestone = ObjectiveView["milestones"][number];

/** What an `objective_update` changed, for the tracker's brief highlight. `n` increases with every update. */
export interface ObjectiveEvent {
  n: number;
  completed: Milestone[];
  /** Set when the stage index went up; holds the new stage. */
  advancedTo: ObjectiveView["stage"] | null;
  finished: boolean;
}

/** The milestones still to do, in order. */
export const openMilestones = (v: ObjectiveView): Milestone[] => v.milestones.filter((m) => !m.done);

/** One-line summary for the collapsed tracker: the next thing to do. */
export function objectiveSummary(v: ObjectiveView): string {
  if (v.finished) return "Story complete";
  const next = openMilestones(v)[0];
  return next ? next.hint : v.stage.title;
}

/** "Stage 2 of 5" (zero-based index in, one-based text out). */
export const stageLabel = (v: ObjectiveView): string => `Stage ${v.stage.index + 1} of ${v.stage.count}`;

/** Progress as a 0..1 fraction, safe for an empty plan. */
export const progressFraction = (v: ObjectiveView): number =>
  v.progress.total <= 0 ? 0 : Math.max(0, Math.min(1, v.progress.done / v.progress.total));

/**
 * Compare the previous view with an update and say what changed. The log lines are what the story log records.
 * With no previous view (first update after joining) a stage change is not announced, only completions and the end.
 */
export function describeObjectiveChange(
  prev: ObjectiveView | null, next: ObjectiveView, completed: readonly Milestone[] = [],
): { event: Omit<ObjectiveEvent, "n">; lines: string[] } {
  const lines: string[] = [];
  for (const m of completed) lines.push(`Objective complete: ${m.hint}`);
  const advancedTo = prev && next.stage.index > prev.stage.index ? next.stage : null;
  const finished = next.finished && !(prev?.finished ?? false);
  if (finished) lines.push("The story is complete.");
  else if (advancedTo) lines.push(`Stage ${advancedTo.index + 1} of ${advancedTo.count}: ${advancedTo.title}. ${advancedTo.goal}`);
  return { event: { completed: [...completed], advancedTo, finished }, lines };
}
