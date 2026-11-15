import { describe, expect, it } from "vitest";
import { ObjectiveViewSchema, type StoryBible } from "@aedm/schemas";
import { milestoneHint, objectiveView } from "./objective-view.ts";
import { BIBLE, CAMPAIGN_BIBLE, PLOT_BIBLE } from "./testkit.ts";

const done = (b: StoryBible, ...ids: string[]): StoryBible => {
  const c = structuredClone(b);
  for (const m of c.milestones) if (ids.includes(m.id)) m.completed = true;
  return c;
};

describe("milestoneHint", () => {
  const ms = (id: string) => CAMPAIGN_BIBLE.milestones.find((m) => m.id === id)!;
  it("uses the bible's own hint", () => {
    expect(milestoneHint(CAMPAIGN_BIBLE, ms("m3"))).toBe("Clear the sentries from the marsh");
  });
  it("derives one from the trigger and the names", () => {
    expect(milestoneHint(CAMPAIGN_BIBLE, ms("m1"))).toBe("Talk to Old Tam at Hollowmere Square");
    expect(milestoneHint(CAMPAIGN_BIBLE, ms("m2"))).toBe("Find the Lantern Lens at The Rotting Dock");
    expect(milestoneHint(CAMPAIGN_BIBLE, ms("m5"))).toBe("Go to The Drowned Crypt");
    expect(milestoneHint(CAMPAIGN_BIBLE, ms("m6"))).toBe("Defeat The Choirmaster at The Choir's Heart");
  });
  it("falls back to the description for story milestones and unknown targets", () => {
    expect(milestoneHint(CAMPAIGN_BIBLE, ms("m4"))).toBe("The party decides who to trust.");
    expect(milestoneHint(CAMPAIGN_BIBLE, { id: "x", description: "Did a thing.", completed: false, trigger: { type: "talk_to", cast: "ghost" } })).toBe("Did a thing.");
  });
  it("keeps a hint within the wire limit", () => {
    const long = { id: "x", description: "d".repeat(300), completed: false };
    expect(milestoneHint(CAMPAIGN_BIBLE, long).length).toBeLessThanOrEqual(100);
  });
});

describe("objectiveView", () => {
  it("is null without a plot", () => {
    expect(objectiveView({ bible: BIBLE })).toBeNull();
  });
  it("shows only the current stage's milestones, with progress over all of them", () => {
    const v = objectiveView({ bible: CAMPAIGN_BIBLE })!;
    expect(ObjectiveViewSchema.safeParse(v).success).toBe(true);
    expect(v.stage).toEqual({ id: "call", index: 0, count: 5, title: "Stage call", goal: "Goal of call." });
    expect(v.milestones).toEqual([{ id: "m1", hint: "Talk to Old Tam at Hollowmere Square", done: false }]);
    expect(v.progress).toEqual({ done: 0, total: 6 });
    expect(v.finished).toBe(false);
  });
  it("keeps completed milestones of the current stage, marked done, and moves on when the stage is done", () => {
    const mid = objectiveView({ bible: done(CAMPAIGN_BIBLE, "m1", "m2", "m3") })!;
    expect(mid.stage.id).toBe("frustration");
    expect(mid.milestones.map((m) => [m.id, m.done])).toEqual([["m3", true], ["m4", false]]);
    expect(mid.progress).toEqual({ done: 3, total: 6 });
    const next = objectiveView({ bible: done(CAMPAIGN_BIBLE, "m1", "m2", "m3", "m4") })!;
    expect(next.stage.id).toBe("nightmare");
    expect(next.milestones.map((m) => m.id)).toEqual(["m5"]);
  });
  it("never leaks later stages or triggers", () => {
    const text = JSON.stringify(objectiveView({ bible: CAMPAIGN_BIBLE }));
    for (const secret of ["m2", "m5", "m6", "e_boss", "k_lens", "c_tam", "trigger", "Choirmaster", "frustration"]) expect(text).not.toContain(secret);
  });
  it("reports a finished story on the last stage", () => {
    const v = objectiveView({ bible: done(CAMPAIGN_BIBLE, "m1", "m2", "m3", "m4", "m5", "m6") })!;
    expect(v.finished).toBe(true);
    expect(v.stage.id).toBe("final_confrontation");
    expect(v.milestones.every((m) => m.done)).toBe(true);
    expect(v.progress).toEqual({ done: 6, total: 6 });
  });
  it("works for a plot bible with no plan, using descriptions", () => {
    const v = objectiveView({ bible: PLOT_BIBLE })!;
    expect(v.milestones.map((m) => m.hint)).toEqual(["anticipation one", "anticipation two"]);
  });
});

describe("state_snapshot", () => {
  it("carries the objective view for a bible with a plot, and none otherwise", async () => {
    const { makeWorld } = await import("./testkit.ts");
    const { toSnapshot } = await import("./state.ts");
    expect(toSnapshot(makeWorld(7, { bible: CAMPAIGN_BIBLE }).state)?.objective).toEqual(objectiveView({ bible: CAMPAIGN_BIBLE }));
    expect(toSnapshot(makeWorld(7).state)?.objective).toBeUndefined();
  });
});
