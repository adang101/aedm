import { describe, expect, it } from "vitest";
import { DM_ACTION_TYPES, DmActionSchema, DmResponseLooseSchema, DmResponseSchema } from "./dm";

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

const brief = {
  setting: { name: "Lighthouse interior", preset: "interior", layout: "rooms_and_corridors", environment: "indoor", mood: "dim" },
  theme_tags: [], size_class: "small",
  rooms: [{ id: "r1", type: "hall", size: "small", connects_to: [] }],
  points_of_interest: [], entity_slots: [], exits: [{ side: "south", label: "Door" }],
};

const actions = [
  { type: "request_check", target: "party", ability: "wis", dc: 15, tags: ["perception"], reason: "Spot the watcher" },
  { type: "create_npc", name: "Odalys Brand", concept: "Friendly innkeeper", role: "quest_giver", map_id: "m_inn", x: 3, y: 4, sprite_tags: ["apron"], appearance: "stout woman in a flour-dusted apron" },
  { type: "npc_say", entity_id: "npc_odalys", text: "Three of them, walking in their sleep." },
  { type: "create_enemy", concept: "A robed chorister", role: "standard", appearance: "pale figure in drowned-blue robes, dripping" },
  { type: "spawn_entity", archetype_id: "en_chorister", map_id: "m_inn", slot_id: "slot_1", count: 2 },
  { type: "start_combat", participants: ["ch_tamsin", "en_1"], difficulty: "standard" },
  { type: "end_combat", reason: "victory" },
  { type: "apply_condition", target: "en_1", condition: "stunned", turns: 1 },
  { type: "grant_item", recipient: "ch_orrin", item: { name: "Brass key", kind: "quest", value: 0 } },
  { type: "update_quest", quest_id: "q1", status: "active", note: "Found the ledger" },
  { type: "set_fact", subject: "Odalys Brand", predicate: "is_alive", object: "true" },
  { type: "generate_map", brief },
  { type: "change_scene", map_id: "m_marsh", entry: "party_start" },
  { type: "award_growth", character_id: "ch_tamsin", amount: 20, reason: "Showed mercy" },
  { type: "complete_milestone", milestone_id: "m1" },
  { type: "adjust_plot", stages: [{ stage_id: "nightmare", goal: "The marsh turns on the party.", milestones: [{ id: "m9", description: "The party flees the drowned chapel." }] }] },
  { type: "suggest_actions", chips: ["Search the desk", "Talk to Odalys"] },
  { type: "npc_note", entity_id: "npc_odalys", note: "Promised to hide the party's boat." },
  { type: "open_thread", text: "Who lit the beacon on the drowned lighthouse?" },
  { type: "close_thread", thread_id: "th_9", resolution: "The keeper did, to call the cult." },
];

describe("DmAction", () => {
  it("every action type in contracts parses", () => {
    for (const a of actions) {
      const r = DmActionSchema.safeParse(a);
      expect(r.success, `${a.type}: ${JSON.stringify(r.error?.issues)}`).toBe(true);
    }
    expect(DM_ACTION_TYPES.sort()).toEqual(actions.map((a) => a.type).sort());
  });
  it("rejects unknown type and unknown fields", () => {
    expect(DmActionSchema.safeParse({ type: "give_gold", amount: 5000 }).success).toBe(false);
    expect(DmActionSchema.safeParse({ ...actions[6], extra: 1 }).success).toBe(false);
  });
  it("dossier and thread actions: optional voice, defaults and strict limits", () => {
    const npc = actions[1] as Record<string, unknown>;
    expect(DmActionSchema.safeParse({ ...npc, voice: "clipped, nautical slang" }).success).toBe(true);
    expect(DmActionSchema.safeParse({ ...npc, voice: "v".repeat(81) }).success).toBe(false);
    expect(DmActionSchema.safeParse({ ...actions[17], note: "n".repeat(121) }).success).toBe(false);
    expect(DmActionSchema.safeParse({ ...actions[17], extra: 1 }).success).toBe(false);
    expect(DmActionSchema.safeParse({ ...actions[18], text: "t".repeat(161) }).success).toBe(false);
    expect(DmActionSchema.safeParse({ ...actions[18], extra: 1 }).success).toBe(false);
    expect(DmActionSchema.parse({ type: "close_thread", thread_id: "th_9" })).toMatchObject({ resolution: "" });
    expect(DmActionSchema.safeParse({ ...actions[19], resolution: "r".repeat(121) }).success).toBe(false);
  });
  it("applies defaults", () => {
    const a = DmActionSchema.parse(actions[0]);
    expect(a).toMatchObject({ advantage: "none" });
  });
  it("field limits", () => {
    expect(DmActionSchema.safeParse({ ...actions[0], tags: ["lore", "stealth", "speed"] }).success).toBe(false);
    expect(DmActionSchema.safeParse({ ...actions[0], tags: ["parkour"] }).success).toBe(false);
    expect(DmActionSchema.safeParse({ ...actions[0], reason: "x".repeat(121) }).success).toBe(false);
    expect(DmActionSchema.safeParse({ ...actions[2], text: words(61) }).success).toBe(false);
    expect(DmActionSchema.safeParse({ ...actions[4], count: 7 }).success).toBe(false);
    expect(DmActionSchema.safeParse({ ...actions[13], amount: 26 }).success).toBe(false);
    expect(DmActionSchema.safeParse({ ...actions[7], turns: 4 }).success).toBe(false);
    expect(DmActionSchema.safeParse({ ...actions[15], chips: ["only one"] }).success).toBe(false);
    expect(DmActionSchema.safeParse({ ...actions[15], chips: ["a", "b", "five words in this chip here"] }).success).toBe(false);
  });
  it("spawn_entity needs coords xor slot", () => {
    const { slot_id: _s, ...noSlot } = actions[4] as Record<string, unknown>;
    expect(DmActionSchema.safeParse(noSlot).success).toBe(false);
    expect(DmActionSchema.safeParse({ ...noSlot, x: 1, y: 0 }).success).toBe(true);
    expect(DmActionSchema.safeParse({ ...noSlot, x: 1 }).success).toBe(false);
    expect(DmActionSchema.safeParse({ ...actions[4], x: 1, y: 1 }).success).toBe(false);
  });
  it("reserved set_fact predicates", () => {
    expect(DmActionSchema.safeParse({ ...actions[10], object: "maybe" }).success).toBe(false);
    expect(DmActionSchema.safeParse({ ...actions[10], predicate: "disposition", object: "grumpy" }).success).toBe(false);
    expect(DmActionSchema.safeParse({ ...actions[10], predicate: "mood", object: "grumpy" }).success).toBe(true);
    expect(DmActionSchema.safeParse({ ...actions[10], predicate: "p".repeat(41) }).success).toBe(false);
  });
});

describe("DmResponse", () => {
  const ok = { v: 1, narration: words(60), actions, importance: 3 };
  it("parses a valid response with several action types", () => {
    const r = DmResponseSchema.safeParse({ ...ok, actions: actions.slice(0, 8), dm_notes: "secret" });
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    expect(r.data?.high_stakes).toBe(false);
  });
  it("max 8 actions", () => {
    expect(DmResponseSchema.safeParse(ok).success).toBe(false);
    expect(DmResponseSchema.safeParse({ ...ok, actions: [] }).success).toBe(true);
  });
  it("narration word bounds", () => {
    const a = { ...ok, actions: [] };
    expect(DmResponseSchema.safeParse({ ...a, narration: words(39) }).success).toBe(false);
    expect(DmResponseSchema.safeParse({ ...a, narration: words(40) }).success).toBe(true);
    expect(DmResponseSchema.safeParse({ ...a, narration: words(150) }).success).toBe(true);
    expect(DmResponseSchema.safeParse({ ...a, narration: words(151) }).success).toBe(false);
    expect(DmResponseSchema.safeParse({ ...a, narration: `<b>${words(50)}</b>` }).success).toBe(false);
  });
  it("dm_notes, importance, v, unknown fields", () => {
    const a = { ...ok, actions: [] };
    expect(DmResponseSchema.safeParse({ ...a, dm_notes: words(101) }).success).toBe(false);
    expect(DmResponseSchema.safeParse({ ...a, importance: 0 }).success).toBe(false);
    expect(DmResponseSchema.safeParse({ ...a, importance: 6 }).success).toBe(false);
    expect(DmResponseSchema.safeParse({ ...a, v: 2 }).success).toBe(false);
    expect(DmResponseSchema.safeParse({ ...a, mood: "x" }).success).toBe(false);
  });
  it("loose schema salvages shape and actions individually", () => {
    const raw = { v: 1, narration: "short", actions: [actions[0], { type: "bogus" }], importance: 9, extra: true };
    expect(DmResponseSchema.safeParse(raw).success).toBe(false);
    const loose = DmResponseLooseSchema.parse(raw);
    const good = loose.actions.filter((a) => DmActionSchema.safeParse(a).success);
    expect(good).toHaveLength(1);
    expect(DmResponseLooseSchema.safeParse({ narration: 3, actions: [] }).success).toBe(false);
    expect(DmResponseLooseSchema.safeParse({ narration: "x", actions: "no" }).success).toBe(false);
  });

  it("generate_map accepts a free-text setting with inline materials and rejects the old biome field", () => {
    const custom = {
      type: "generate_map",
      brief: {
        ...brief,
        setting: {
          name: "Sunken cathedral", layout: "rooms_and_corridors", environment: "underground", mood: "eerie",
          materials: { floor: ["stone_floor"], liquid: [{ name: "Black water", role: "liquid", color: "#101030", pattern: "waves" }] },
          density: { obstacles: 1, liquid: 2, hazards: 0 },
        },
      },
    };
    expect(DmActionSchema.safeParse(custom).success).toBe(true);
    expect(DmActionSchema.safeParse({ type: "generate_map", brief: { ...brief, biome: "forest" } }).success).toBe(false);
    const { setting: _s, ...noSetting } = brief;
    expect(DmActionSchema.safeParse({ type: "generate_map", brief: noSetting }).success).toBe(false);
  });
  it("create_npc and create_enemy appearance is optional and at most 160 chars", () => {
    const npc = { type: "create_npc", name: "A", concept: "c", role: "ally", map_id: "m_a", x: 1, y: 1, sprite_tags: [] };
    expect(DmActionSchema.safeParse(npc).success).toBe(true);
    expect(DmActionSchema.safeParse({ ...npc, appearance: "x".repeat(161) }).success).toBe(false);
    const en = { type: "create_enemy", concept: "c", role: "minion" };
    expect(DmActionSchema.safeParse({ ...en, appearance: "x".repeat(160) }).success).toBe(true);
    expect(DmActionSchema.safeParse({ ...en, appearance: "x".repeat(161) }).success).toBe(false);
  });
});
