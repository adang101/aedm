import { describe, expect, it } from "vitest";
import { NpcRecordSchema, StoryBibleSchema, StoryThreadSchema } from "./world";
import { RoomSettingsPatchSchema, RoomSettingsSchema } from "./ws";

const base = {
  title: "T", digest: "D", tone: "eerie",
  milestones: [{ id: "m1", description: "x", completed: false }],
  quests: [],
};

describe("story bible plot", () => {
  it("still parses a bible without plot or milestone stages", () => {
    expect(StoryBibleSchema.safeParse(base).success).toBe(true);
  });
  it("parses a plot and milestone stages", () => {
    const r = StoryBibleSchema.safeParse({
      ...base,
      plot: { pattern: "tragedy", arc: "rise_fall", stages: [{ id: "anticipation", title: "The offer", goal: "Meet the patron." }] },
      milestones: [{ id: "m1", description: "x", completed: false, stage: "anticipation" }],
    });
    expect(r.success).toBe(true);
  });
  it("rejects unknown patterns and arcs", () => {
    const stages = [{ id: "a", title: "A", goal: "g" }];
    expect(StoryBibleSchema.safeParse({ ...base, plot: { pattern: "heist", arc: "rise", stages } }).success).toBe(false);
    expect(StoryBibleSchema.safeParse({ ...base, plot: { pattern: "comedy", arc: "sideways", stages } }).success).toBe(false);
  });
});

describe("npc dossier and story threads", () => {
  const npc = { id: "npc_1", name: "Odalys", concept: "Innkeeper", role: "ally", map_id: "m_inn", x: 1, y: 2, sprite_tags: [] };
  it("an NPC record parses with and without the dossier fields", () => {
    expect(NpcRecordSchema.safeParse(npc).success).toBe(true);
    expect(NpcRecordSchema.safeParse({ ...npc, voice: "warm", lines: ["Hello."], notes: ["Owes a favor"], last_seen_beat: 3 }).success).toBe(true);
  });
  it("rejects over-long dossier text and a negative beat", () => {
    expect(NpcRecordSchema.safeParse({ ...npc, voice: "v".repeat(81) }).success).toBe(false);
    expect(NpcRecordSchema.safeParse({ ...npc, lines: ["l".repeat(121)] }).success).toBe(false);
    expect(NpcRecordSchema.safeParse({ ...npc, notes: ["n".repeat(121)] }).success).toBe(false);
    expect(NpcRecordSchema.safeParse({ ...npc, last_seen_beat: -1 }).success).toBe(false);
  });
  it("a story thread is strict", () => {
    const t = { id: "th_1", text: "Who lit the beacon?", status: "open" };
    expect(StoryThreadSchema.safeParse(t).success).toBe(true);
    expect(StoryThreadSchema.safeParse({ ...t, status: "closed", resolution: "The keeper." }).success).toBe(true);
    expect(StoryThreadSchema.safeParse({ ...t, status: "stalled" }).success).toBe(false);
    expect(StoryThreadSchema.safeParse({ ...t, extra: 1 }).success).toBe(false);
    expect(StoryThreadSchema.safeParse({ ...t, text: "t".repeat(161) }).success).toBe(false);
  });
});

describe("room settings plot fields", () => {
  const s = { content_rating: "teen", campaign_pitch: "", dev_solo: false };
  it("are optional", () => {
    expect(RoomSettingsSchema.safeParse(s).success).toBe(true);
    expect(RoomSettingsSchema.safeParse({ ...s, plot_pattern: "auto", plot_arc: "fall_rise" }).success).toBe(true);
    expect(RoomSettingsPatchSchema.parse({ plot_pattern: "comedy" })).toEqual({ plot_pattern: "comedy" });
  });
  it("reject unknown ids", () => {
    expect(RoomSettingsSchema.safeParse({ ...s, plot_pattern: "heist" }).success).toBe(false);
  });
});
