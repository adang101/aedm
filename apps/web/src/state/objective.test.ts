import type { ObjectiveView, ServerMessage } from "@aedm/schemas";
import { describe, expect, it } from "vitest";
import { MockObjective } from "../net/mock-objective";
import { describeObjectiveChange, objectiveSummary, progressFraction, stageLabel } from "./objective";
import { applyServerMessage, createInitialState, resetRoom } from "./store";

let n = 0;
const msg = <T extends ServerMessage["type"]>(type: T, payload: Extract<ServerMessage, { type: T }>["payload"]) =>
  ({ v: 8, type, id: `s${++n}`, ts: 0, payload }) as unknown as ServerMessage;

const view = (over: Partial<ObjectiveView> = {}): ObjectiveView => ({
  stage: { id: "st1", index: 0, count: 3, title: "Arrival", goal: "Learn what is wrong." },
  milestones: [{ id: "a", hint: "Talk to the keeper", done: false }, { id: "b", hint: "Reach the crypt", done: false }],
  progress: { done: 0, total: 5 }, finished: false, ...over,
});

describe("objective helpers", () => {
  it("summarises the next open objective, or the end", () => {
    expect(objectiveSummary(view())).toBe("Talk to the keeper");
    const half = view({ milestones: [{ id: "a", hint: "Talk to the keeper", done: true }, { id: "b", hint: "Reach the crypt", done: false }] });
    expect(objectiveSummary(half)).toBe("Reach the crypt");
    expect(objectiveSummary(view({ finished: true }))).toBe("Story complete");
  });

  it("labels the stage one-based and bounds progress", () => {
    expect(stageLabel(view())).toBe("Stage 1 of 3");
    expect(progressFraction(view({ progress: { done: 2, total: 4 } }))).toBe(0.5);
    expect(progressFraction(view({ progress: { done: 0, total: 0 } }))).toBe(0);
  });

  it("describes completions, stage advances and the end", () => {
    const next = view({ stage: { id: "st2", index: 1, count: 3, title: "Below", goal: "Go down." } });
    const adv = describeObjectiveChange(view(), next, [{ id: "b", hint: "Reach the crypt", done: true }]);
    expect(adv.lines).toEqual(["Objective complete: Reach the crypt", "Stage 2 of 3: Below. Go down."]);
    expect(adv.event.advancedTo?.id).toBe("st2");
    const end = describeObjectiveChange(next, view({ finished: true, stage: next.stage }));
    expect(end.lines).toEqual(["The story is complete."]);
    expect(describeObjectiveChange(null, next).lines).toEqual([]);
  });
});

describe("store: objective", () => {
  it("takes the objective from a snapshot and clears it when absent", () => {
    const s = createInitialState();
    const snap = { seq: 1, mode: "exploration" as const, entities: [], party: [], quests: [], map: { id: "m" } as never };
    applyServerMessage(s, msg("state_snapshot", { ...snap, objective: view() }), 0);
    expect(s.objective?.stage.title).toBe("Arrival");
    expect(s.log).toHaveLength(0);
    applyServerMessage(s, msg("state_snapshot", { ...snap, seq: 2 }), 0);
    expect(s.objective).toBeNull();
  });

  it("applies objective_update, logs system lines and records the event", () => {
    const s = createInitialState();
    s.objective = view();
    const next = view({
      milestones: [{ id: "a", hint: "Talk to the keeper", done: true }, { id: "b", hint: "Reach the crypt", done: false }],
      progress: { done: 1, total: 5 },
    });
    applyServerMessage(s, msg("objective_update", { ...next, completed: [{ id: "a", hint: "Talk to the keeper", done: true }] }), 0);
    expect(s.objective?.progress.done).toBe(1);
    expect(s.objectiveEvent).toMatchObject({ n: 1, advancedTo: null, finished: false });
    expect(s.log.map((l) => [l.kind, l.text])).toEqual([["system", "Objective complete: Talk to the keeper"]]);
    const after = view({ stage: { id: "st2", index: 1, count: 3, title: "Below", goal: "Go down." }, progress: { done: 2, total: 5 } });
    applyServerMessage(s, msg("objective_update", { ...after, completed: [{ id: "b", hint: "Reach the crypt", done: true }] }), 0);
    expect(s.objectiveEvent?.n).toBe(2);
    expect(s.objectiveEvent?.advancedTo?.title).toBe("Below");
    expect(s.log.at(-1)?.text).toBe("Stage 2 of 3: Below. Go down.");
  });

  it("an update with nothing completed still replaces the view without logging", () => {
    const s = createInitialState();
    applyServerMessage(s, msg("objective_update", view()), 0);
    expect(s.objective).not.toBeNull();
    expect(s.log).toHaveLength(0);
  });

  it("resets with the room", () => {
    const s = createInitialState();
    applyServerMessage(s, msg("objective_update", view()), 0);
    resetRoom(s);
    expect(s.objective).toBeNull();
    expect(s.objectiveEvent).toBeNull();
  });
});

describe("mock objective", () => {
  it("completes only the current stage, advances, and finishes", () => {
    const o = new MockObjective();
    expect(o.view().stage.index).toBe(0);
    expect(o.complete("m_crypt")).toBeNull(); // later stage
    expect(o.complete("m_odalys")?.view.progress.done).toBe(1);
    expect(o.complete("m_odalys")).toBeNull(); // already done
    expect(o.complete("m_choir")?.view.stage.index).toBe(1);
    while (!o.view().finished) expect(o.completeNext()).not.toBeNull();
    expect(o.view().progress.done).toBe(o.view().progress.total);
    expect(o.completeNext()).toBeNull();
  });
});
