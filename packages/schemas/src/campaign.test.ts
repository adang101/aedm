import { describe, expect, it } from "vitest";
import { MilestoneTriggerSchema, ObjectiveUpdatePayload, ObjectiveViewSchema, PlanEncounterSchema, PlanLocationSchema } from "./campaign";
import { StoryBibleSchema } from "./world";
import { ServerMessageSchema, StateSnapshotPayload, WS_VERSION } from "./ws";

const base = { title: "T", digest: "D", tone: "eerie", milestones: [{ id: "m1", description: "x", completed: false }], quests: [] };
const setting = { name: "Marsh", layout: "open_field", environment: "outdoor", mood: "eerie" };
const loc = { id: "dock", name: "The Dock", summary: "A rotting pier.", stage: "call", connects_to: ["square"], setting };
const view = {
  stage: { id: "call", index: 0, count: 5, title: "The call", goal: "Find the ferryman." },
  milestones: [{ id: "m1", hint: "Find the ferryman at the dock", done: false }],
  progress: { done: 0, total: 5 },
  finished: false,
};

describe("campaign plan on the bible", () => {
  it("a bible without the plan still parses, and milestones need no hint or trigger", () => {
    expect(StoryBibleSchema.safeParse(base).success).toBe(true);
  });
  it("parses locations, cast, encounters, key items, ending and milestone triggers", () => {
    const r = StoryBibleSchema.safeParse({
      ...base,
      locations: [loc],
      cast: [{ id: "ferryman", name: "Old Tam", concept: "A ferryman who knows too much.", role: "quest_giver", location: "dock", voice: "gruff" }],
      encounters: [{ id: "e1", name: "Dock thugs", location: "dock", stage: "call", groups: [{ concept: "A hired thug", role: "minion", count: 2 }] }],
      key_items: [{ id: "k1", name: "Brass Key", location: "dock", held_by: { kind: "cast", id: "ferryman" } }],
      ending: { goal: "Silence the Choir.", success: "The sleepers wake.", failure: "The marsh keeps them." },
      milestones: [{ id: "m1", description: "x", completed: false, hint: "Find Tam", trigger: { type: "talk_to", cast: "ferryman" } }],
    });
    expect(r.success).toBe(true);
  });
  it("is strict about locations and triggers", () => {
    expect(PlanLocationSchema.safeParse({ ...loc, extra: 1 }).success).toBe(false);
    expect(PlanLocationSchema.safeParse({ ...loc, connects_to: ["a", "b", "c", "d", "e"] }).success).toBe(false);
    expect(PlanLocationSchema.safeParse({ ...loc, setting: { name: "x" } }).success).toBe(false);
    expect(PlanEncounterSchema.safeParse({ id: "e", name: "n", location: "dock", stage: "call", groups: [] }).success).toBe(false);
    expect(MilestoneTriggerSchema.safeParse({ type: "story" }).success).toBe(true);
    expect(MilestoneTriggerSchema.safeParse({ type: "reach_location" }).success).toBe(false);
    expect(MilestoneTriggerSchema.safeParse({ type: "kill_everything" }).success).toBe(false);
  });
});

describe("objective view and wire", () => {
  it("parses the view and the update, and is strict", () => {
    expect(ObjectiveViewSchema.safeParse(view).success).toBe(true);
    expect(ObjectiveViewSchema.safeParse({ ...view, trigger: 1 }).success).toBe(false);
    expect(ObjectiveUpdatePayload.safeParse({ ...view, completed: [{ id: "m1", hint: "Find Tam", done: true }] }).success).toBe(true);
  });
  it("objective_update is a server message and state_snapshot may carry the view", () => {
    const env = { v: WS_VERSION, type: "objective_update", id: "s1", ts: 1, payload: view };
    expect(ServerMessageSchema.safeParse(env).success).toBe(true);
    expect(StateSnapshotPayload.shape.objective.safeParse(view).success).toBe(true);
  });
});
