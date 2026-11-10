import { describe, expect, it } from "vitest";
import { ClientMessageSchema, MAX_MESSAGE_BYTES, ServerMessageSchema, WS_VERSION, WsEnvelopeSchema, exceedsMaxBytes } from "./ws";
import { BRINDLE } from "./fixtures/party";
import { makeMap } from "./fixtures/map";

const env = (type: string, payload: unknown, extra: object = {}) => ({ v: 1, type, id: "c1", ts: 1700000000000, payload, ...extra });
const sprite = { kind: "shape", shape: "circle", color: "#112233", accent: "#445566", glyph: "A" };
const view = { id: "ch_a", kind: "pc", name: "A", x: 1, y: 2, hp: 5, hp_max: 10, conditions: [{ condition: "stunned", turns: 1 }], sprite };

describe("ws constants", () => {
  it("exports", () => {
    expect(WS_VERSION).toBe(1);
    expect(MAX_MESSAGE_BYTES).toBe(8192);
    expect(exceedsMaxBytes("x".repeat(8193))).toBe(true);
    expect(exceedsMaxBytes("x".repeat(8192))).toBe(false);
  });
});

describe("client messages", () => {
  it("parses lobby and gameplay messages", () => {
    const msgs = [
      env("create_room", { display_name: "Ana" }),
      env("join_room", { invite_code: "ABCD", display_name: "Bo" }),
      env("join_room", { invite_code: "ABCD", display_name: "Bo", auth_token: "tok" }),
      env("set_ready", { ready: true }),
      env("update_settings", { content_rating: "teen" }),
      env("start_game", {}),
      env("claim_character", { character_id: "ch_a" }),
      env("move_intent", { x: 3, y: 4 }),
      env("move_intent", { direction: "n" }),
      env("act", { verb: "examine", target_id: "desk" }),
      env("use_ability", { ability_id: "ab_x", target: { x: 1, y: 1 } }),
      env("use_ability", { ability_id: "ab_x", target: "en_1" }),
      env("basic_attack", { target_id: "en_1" }),
      env("end_turn", {}),
      env("say", { text: "hello", channel: "ic" }),
      env("vote_cast", { vote_id: "v1", choice: "wait" }),
      env("request_save", { name: "Before boss" }),
      env("ping", {}),
    ];
    for (const m of msgs) {
      const r = ClientMessageSchema.safeParse(m);
      expect(r.success, `${m.type}: ${JSON.stringify(r.error?.issues)}`).toBe(true);
    }
  });
  it("claim new character", () => {
    const character = {
      v: 1, name: "M", key_ability: "cha", scores: { str: 8, dex: 12, con: 13, int: 10, wis: 13, cha: 15 },
      trait_tags: ["lore", "performance"], sprite_recipe: sprite, ability_texts: ["Sing loudly"],
    };
    expect(ClientMessageSchema.safeParse(env("claim_character", { character_id: "new", character })).success).toBe(true);
    expect(ClientMessageSchema.safeParse(env("claim_character", { character_id: "new" })).success).toBe(false);
    expect(ClientMessageSchema.safeParse(env("claim_character", { character_id: "ch_a", character })).success).toBe(false);
  });
  it("rejects oversize say, bad channel, unknown type, bad version, unknown fields", () => {
    expect(ClientMessageSchema.safeParse(env("say", { text: "x".repeat(501), channel: "ic" })).success).toBe(false);
    expect(ClientMessageSchema.safeParse(env("say", { text: "x".repeat(500), channel: "ic" })).success).toBe(true);
    expect(ClientMessageSchema.safeParse(env("say", { text: "hi", channel: "dm" })).success).toBe(false);
    expect(ClientMessageSchema.safeParse(env("teleport_hack", {})).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ ...env("ping", {}), v: 2 }).success).toBe(false);
    expect(ClientMessageSchema.safeParse(env("ping", {}, { extra: 1 })).success).toBe(false);
    expect(ClientMessageSchema.safeParse(env("create_room", { display_name: "x".repeat(25) })).success).toBe(false);
    expect(ClientMessageSchema.safeParse(env("create_room", { display_name: "  " })).success).toBe(false);
    expect(ClientMessageSchema.safeParse(env("move_intent", { x: 1, y: 1, direction: "n" })).success).toBe(false);
  });
  it("generic envelope for routing", () => {
    expect(WsEnvelopeSchema.safeParse(env("anything", { a: 1 })).success).toBe(true);
    expect(WsEnvelopeSchema.safeParse({ type: "x" }).success).toBe(false);
  });
});

describe("server messages", () => {
  it("parses lobby, joined, chat, log, errors", () => {
    const msgs = [
      env("room_created", { room_id: "r1", invite_code: "ABCD" }, { ack_id: "c1" }),
      env("joined", { player_id: "p1", auth_token: "tok", room_id: "r1" }, { ack_id: "c1" }),
      env("lobby_state", {
        room_id: "r1", invite_code: "ABCD", host_player_id: "p1", phase: "lobby",
        settings: { content_rating: "family", campaign_pitch: "Fog and lanterns", dev_solo: false },
        players: [{ player_id: "p1", display_name: "Ana", status: "online", ready: false, character_id: null }],
      }),
      env("chat", { from_id: "p1", from_name: "Ana", channel: "ooc", text: "brb" }),
      env("log", { kind: "narration", text: "The fog rolls in.", turn_id: "t1" }),
      env("narration_chunk", { turn_id: "t1", text: "The fog", done: false }),
      env("roll_result", { who: "ch_a", label: "Perception", dice: [17], modifier: 1, total: 18, target: 15, outcome: "success" }),
      env("combat_state", { round: 1, order: [{ entity_id: "ch_a", initiative: 15 }], active_id: "ch_a" }),
      env("presence", { player_id: "p1", status: "autopilot" }),
      env("chips", { chips: ["Search desk", "Leave"] }),
      env("error", { code: "version_mismatch", message: "Reload the page", ack_id: "c1" }, { ack_id: "c1" }),
      env("pong", {}),
      env("state_diff", { seq: 5, ack_seq: 4, changed: [view], removed: ["en_9"], mode: "combat" }),
    ];
    for (const m of msgs) {
      const r = ServerMessageSchema.safeParse(m);
      expect(r.success, `${m.type}: ${JSON.stringify(r.error?.issues)}`).toBe(true);
    }
  });
  it("state_snapshot with map, entities, party, quests", () => {
    const { user_id: _u, campaign_id: _c, inventory: _i, ...pub } = BRINDLE;
    const payload = {
      seq: 1, mode: "exploration", map: makeMap(), entities: [view], party: [pub],
      quests: [{ id: "q1", title: "Find Edda", status: "active", notes: [] }],
    };
    const r = ServerMessageSchema.safeParse(env("state_snapshot", payload));
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    expect(ServerMessageSchema.safeParse(env("state_snapshot", { ...payload, secret: 1 })).success).toBe(false);
  });
  it("rejects bad lobby status and unknown type", () => {
    expect(ServerMessageSchema.safeParse(env("presence", { player_id: "p1", status: "asleep" })).success).toBe(false);
    expect(ServerMessageSchema.safeParse(env("secret_dm_notes", {})).success).toBe(false);
    expect(ServerMessageSchema.safeParse(env("chips", { chips: ["one"] })).success).toBe(false);
  });
});

describe("level-up messages", () => {
  const ability = BRINDLE.abilities[0]!;
  it("level_up_choice payloads", () => {
    const ok = [
      { kind: "score", ability: "con" },
      { kind: "new_ability", text: "Chain lightning that jumps between enemies" },
      { kind: "reforge", ability_id: "ab_x", text: "Make it burst" },
      { kind: "skip_ability" },
    ];
    for (const p of ok) expect(ClientMessageSchema.safeParse(env("level_up_choice", p)).success, JSON.stringify(p)).toBe(true);
    const bad = [
      { kind: "score", ability: "luck" },
      { kind: "new_ability", text: "" },
      { kind: "new_ability", text: "x".repeat(301) },
      { kind: "reforge", text: "no id" },
      { kind: "skip_ability", extra: 1 },
      { kind: "heal" },
    ];
    for (const p of bad) expect(ClientMessageSchema.safeParse(env("level_up_choice", p)).success, JSON.stringify(p)).toBe(false);
  });
  it("level_up_state and level_up_result", () => {
    const state = {
      character_id: "ch_a", level: 3, score_points: 1, ability_picks: 2, budget: 40, budget_used: 19, per_ability_cap: 18,
      caps: { max_avg: 11, max_radius: 1, max_stun_turns: 1 }, abilities: [ability], scores: BRINDLE.scores,
    };
    expect(ServerMessageSchema.safeParse(env("level_up_state", state)).success).toBe(true);
    expect(ServerMessageSchema.safeParse(env("level_up_state", { ...state, score_points: -1 })).success).toBe(false);
    expect(ServerMessageSchema.safeParse(env("level_up_state", { ...state, extra: 1 })).success).toBe(false);
    expect(ServerMessageSchema.safeParse(env("level_up_result", { ok: true, message: "Learned it", forge_notes: ["a"], ability })).success).toBe(true);
    expect(ServerMessageSchema.safeParse(env("level_up_result", { ok: false, message: "Finish the fight first.", forge_notes: [] })).success).toBe(true);
    expect(ServerMessageSchema.safeParse(env("level_up_result", { ok: true, message: "x" })).success).toBe(false);
  });
});
