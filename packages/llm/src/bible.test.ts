import { describe, expect, it } from "vitest";
import { validateCampaign } from "@aedm/engine";
import { StoryBibleSchema, type StoryBible } from "@aedm/schemas";
import { bibleSystem, checkBible, generateStoryBible } from "./bible";
import { lanternMarshBible } from "./default-bible";
import { MAX_OUTPUT_TOKENS } from "./provider";
import { createFakeProvider } from "./providers/fake";
import { templateKeys } from "./template";

const input = { pitch: "A drowned coast", partyBriefs: ["Brindle: demolitions"], contentRating: "family" };
const plot = { pattern: "overcoming_the_monster" as const, arc: "fall_rise" as const };

/** A different story, with the model's own plan. */
function ownStory(edit: (b: StoryBible) => void = () => {}): StoryBible {
  const b = structuredClone(lanternMarshBible());
  b.title = "The Glass Orchard";
  edit(b);
  return b;
}

/** The model's story is fine but its plan is not: a milestone trigger names a cast member that does not exist. */
const brokenPlan = (b: StoryBible) => { b.milestones[0]!.trigger = { type: "talk_to", cast: "c_nobody" }; };

describe("checkBible", () => {
  it("accepts a bible with a valid plan", () => {
    expect(checkBible(lanternMarshBible(), plot)).toBeUndefined();
  });
  it("lists the plan's reasons, so the repair call is precise", () => {
    const b = ownStory(brokenPlan);
    const why = checkBible(b, plot)!;
    expect(why).toContain("- milestone m1: unknown cast c_nobody");
    expect(validateCampaign(b).length).toBeGreaterThan(0);
  });
  it("requires a plan, and a plot", () => {
    const { locations: _l, cast: _c, encounters: _e, key_items: _k, ending: _n, ...bare } = lanternMarshBible();
    expect(checkBible(bare)).toContain("campaign plan: locations, cast, encounters, key_items and ending are required");
    const { plot: _p, ...noPlot } = lanternMarshBible();
    expect(checkBible(noPlot)).toContain("- plot: required");
  });
  it("caps the reasons it lists", () => {
    const b = ownStory((x) => { for (const l of x.locations!) l.connects_to = ["l_nowhere"]; x.cast!.forEach((c) => { c.location = "l_nowhere"; }); x.encounters!.forEach((e) => { e.location = "l_nowhere"; }); });
    const lines = checkBible(b, plot)!.split("\n");
    expect(lines.length).toBeLessThanOrEqual(13);
    expect(lines.at(-1)).toMatch(/more\)$/);
  });
});

describe("generateStoryBible with a campaign plan", () => {
  it("asks for the plan, with the engine's layouts and presets filled in, and a cap big enough for the reply", async () => {
    const p = createFakeProvider();
    const b = await generateStoryBible(p, { ...input, plot });
    const req = p.requests[0]!;
    expect(req.system).toContain("locations");
    expect(req.system).toContain("rooms_and_corridors");
    expect(req.system).toContain("mountain_pass");
    expect(templateKeys(req.system)).toEqual([]);
    expect(req.system).toBe(bibleSystem());
    expect(req.maxTokens).toBe(MAX_OUTPUT_TOKENS.bible);
    expect(MAX_OUTPUT_TOKENS.bible).toBeGreaterThanOrEqual(8000);
    expect(StoryBibleSchema.safeParse(b).success).toBe(true);
    expect(validateCampaign(b)).toEqual([]);
    expect(b.locations!.length).toBeGreaterThanOrEqual(3);
    expect(p.requests).toHaveLength(1);
  });

  it("keeps the model's own valid plan", async () => {
    const own = ownStory();
    const p = createFakeProvider([JSON.stringify(own)]);
    const b = await generateStoryBible(p, { ...input, plot });
    expect(b.title).toBe("The Glass Orchard");
    expect(b.locations).toEqual(own.locations);
    expect(p.requests).toHaveLength(1);
  });

  it("repairs once with the plan's reasons", async () => {
    const p = createFakeProvider([JSON.stringify(ownStory(brokenPlan)), JSON.stringify(ownStory())]);
    const b = await generateStoryBible(p, { ...input, plot });
    expect(p.requests).toHaveLength(2);
    expect(p.requests[1]!.purpose).toBe("repair");
    expect(p.requests[1]!.messages.at(-1)!.content).toContain("milestone m1: unknown cast c_nobody");
    expect(b.title).toBe("The Glass Orchard");
    expect(validateCampaign(b)).toEqual([]);
  });

  it("keeps the story and builds the offline plan when the plan stays invalid after the repair", async () => {
    const bad = JSON.stringify(ownStory(brokenPlan));
    const p = createFakeProvider([bad, bad]);
    const b = await generateStoryBible(p, { ...input, plot, seed: 9 });
    expect(p.requests).toHaveLength(2);
    expect(b.title).toBe("The Glass Orchard");
    expect(validateCampaign(b)).toEqual([]);
    expect(StoryBibleSchema.safeParse(b).success).toBe(true);
    expect(b.locations).not.toEqual(lanternMarshBible().locations);
    expect(b.milestones.some((m) => m.trigger && m.trigger.type !== "story")).toBe(true);
  });

  it("builds the offline plan for a story that came without any plan", async () => {
    const { locations: _l, cast: _c, encounters: _e, key_items: _k, ending: _n, ...bare } = ownStory();
    const reply = JSON.stringify({ ...bare, milestones: bare.milestones.map(({ trigger: _t, hint: _h, ...m }) => m) });
    const b = await generateStoryBible(createFakeProvider([reply, reply]), { ...input, plot });
    expect(b.title).toBe("The Glass Orchard");
    expect(validateCampaign(b)).toEqual([]);
    expect(b.locations!.length).toBeGreaterThanOrEqual(3);
  });

  it("falls back to the built-in bible, with its hand-written plan, when the reply is not usable at all", async () => {
    const b = await generateStoryBible(createFakeProvider(["nope", "{}"]), { ...input, plot });
    expect(b.title).toBe("The Lantern Marsh");
    expect(validateCampaign(b)).toEqual([]);
    expect(b.locations![0]!.name).toBe("Hollowmere Square");
  });

  it("falls back to the built-in bible when the plot was ignored, even if the plan is fine", async () => {
    const wrong = JSON.stringify(lanternMarshBible("tragedy", "fall"));
    const b = await generateStoryBible(createFakeProvider([wrong, wrong]), { ...input, plot: { pattern: "rebirth", arc: "rise" } });
    expect(b.plot).toMatchObject({ pattern: "rebirth", arc: "rise" });
    expect(validateCampaign(b)).toEqual([]);
  });
});
