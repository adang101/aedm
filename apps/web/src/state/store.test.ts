import type { EntityView, ServerMessage } from "@aedm/schemas";
import { describe, expect, it } from "vitest";
import { applyServerMessage, createInitialState, myEntity, pendingLevelUp, resetRoom } from "./store";

const sprite = { kind: "shape", shape: "circle", color: "#4f8a3c", accent: "#f6e8a0", glyph: "A" } as const;
const ent = (id: string, x: number, y: number, extra: Partial<EntityView> = {}): EntityView => ({
  id, kind: "pc", name: id, x, y, hp: 10, hp_max: 10, conditions: [], sprite, ...extra,
});
let n = 0;
const msg = <T extends ServerMessage["type"]>(type: T, payload: Extract<ServerMessage, { type: T }>["payload"]) =>
  ({ v: 1, type, id: `s${++n}`, ts: 0, payload }) as unknown as ServerMessage;

function withSnapshot() {
  const s = createInitialState();
  applyServerMessage(s, msg("joined", { player_id: "p1", auth_token: "t", room_id: "r" }), 0);
  applyServerMessage(s, msg("state_snapshot", {
    seq: 5, mode: "exploration", entities: [ent("a", 1, 1, { owner_player_id: "p1" }), ent("b", 2, 2, { kind: "enemy" })],
    party: [], quests: [], map: { v: 1, id: "m_x" } as never,
  }), 0);
  return s;
}

describe("store", () => {
  it("applies a snapshot and finds my entity", () => {
    const s = withSnapshot();
    expect(s.seq).toBe(5);
    expect(Object.keys(s.entities).sort()).toEqual(["a", "b"]);
    expect(myEntity(s)?.id).toBe("a");
  });

  it("applies diffs: changed, removed, mode and combat", () => {
    const s = withSnapshot();
    applyServerMessage(s, msg("state_diff", { seq: 6, changed: [ent("a", 3, 3), ent("c", 9, 9)], removed: ["b"] }), 0);
    expect(s.entities.a?.x).toBe(3);
    expect(s.entities.b).toBeUndefined();
    expect(s.entities.c).toBeDefined();
    applyServerMessage(s, msg("state_diff", { seq: 7, changed: [], removed: [], mode: "combat", combat: { round: 1, order: [{ entity_id: "a", initiative: 12 }], active_id: "a" } }), 0);
    expect(s.mode).toBe("combat");
    expect(s.combat?.active_id).toBe("a");
    applyServerMessage(s, msg("state_diff", { seq: 8, changed: [], removed: [], mode: "exploration" }), 0);
    expect(s.combat).toBeNull();
  });

  it("ignores stale diffs and flags gaps", () => {
    const s = withSnapshot();
    applyServerMessage(s, msg("state_diff", { seq: 5, changed: [ent("a", 9, 9)], removed: [] }), 0);
    expect(s.entities.a?.x).toBe(1);
    applyServerMessage(s, msg("state_diff", { seq: 9, changed: [ent("a", 4, 4)], removed: [] }), 0);
    expect(s.needsResync).toBe(true);
    expect(s.entities.a?.x).toBe(4);
  });

  it("streams narration chunks into one log entry", () => {
    const s = createInitialState();
    applyServerMessage(s, msg("narration_chunk", { turn_id: "t1", text: "The door ", done: false }), 0);
    applyServerMessage(s, msg("narration_chunk", { turn_id: "t1", text: "creaks.", done: true }), 0);
    expect(s.log).toHaveLength(1);
    expect(s.log[0]).toMatchObject({ kind: "narration", text: "The door creaks.", done: true });
    expect(s.log[0]!.rev).toBe(2);
  });

  it("turns a vote with no time left into no vote", () => {
    const s = createInitialState();
    applyServerMessage(s, msg("vote_state", { vote_id: "v", topic: "t", options: ["skip"], tally: {}, seconds_left: 10 }), 100);
    expect(s.vote?.vote_id).toBe("v");
    applyServerMessage(s, msg("vote_state", { vote_id: "v", topic: "t", options: ["skip"], tally: {}, seconds_left: 0 }), 200);
    expect(s.vote).toBeNull();
  });

  it("records chat, rolls and claimed characters", () => {
    const s = createInitialState();
    applyServerMessage(s, msg("chat", { from_id: "p1", from_name: "Ann", channel: "ic", text: "hi" }), 0);
    applyServerMessage(s, msg("roll_result", { who: "a", label: "Perception", dice: [12], modifier: 2, total: 14, target: 12, outcome: "success" }), 0);
    applyServerMessage(s, msg("character_claimed", { character_id: "ch1", player_id: "p1" }), 0);
    expect(s.log.map((l) => l.kind)).toEqual(["chat", "roll"]);
    expect(s.claimed.ch1).toBe("p1");
  });
});

describe("level-up state", () => {
  const scores = { str: 10, dex: 12, con: 14, int: 15, wis: 10, cha: 8 };
  const lu = (over: Record<string, unknown> = {}) => ({
    character_id: "a", level: 2, score_points: 0, ability_picks: 1, budget: 35, budget_used: 19, per_ability_cap: 15,
    caps: { max_avg: 9, max_radius: 1, max_stun_turns: 1 }, abilities: [], scores, ...over,
  }) as Extract<ServerMessage, { type: "level_up_state" }>["payload"];

  it("stores level_up_state, reports pending picks, and closes at zero", () => {
    const s = createInitialState();
    expect(pendingLevelUp(s)).toBeNull();
    applyServerMessage(s, msg("level_up_state", lu()), 0);
    expect(pendingLevelUp(s)?.ability_picks).toBe(1);
    applyServerMessage(s, msg("level_up_state", lu({ ability_picks: 0 })), 0);
    expect(pendingLevelUp(s)).toBeNull();
    expect(s.levelUp?.level).toBe(2);
  });

  it("level_up_result and errors clear the busy flag; resetRoom clears everything", () => {
    const s = createInitialState();
    s.levelUpBusy = true;
    applyServerMessage(s, msg("level_up_result", { ok: true, message: "Learned it", forge_notes: ["n"] }), 0);
    expect(s.levelUpBusy).toBe(false);
    expect(s.levelUpResult?.message).toBe("Learned it");
    s.levelUpBusy = true;
    applyServerMessage(s, msg("error", { code: "invalid_state", message: "Finish the fight first." }), 0);
    expect(s.levelUpBusy).toBe(false);
    applyServerMessage(s, msg("level_up_state", lu()), 0);
    resetRoom(s);
    expect(s.levelUp).toBeNull();
    expect(s.levelUpResult).toBeNull();
  });
});

describe("Workshop and cast state", () => {
  const env = (type: string, payload: unknown) => msg(type as "pong", payload as never);
  const spec = {
    kind: "spec", v: 1, body: "avian", size: "medium", glyph: "H", traits: "",
    palette: { primary: "#112233", secondary: "#445566", accent: "#778899", detail: "#001122" }, parts: [],
  };
  it("sprite_assets_list fills the account's Workshop and logout clears it", () => {
    const s = createInitialState();
    const asset = { id: "as_1", name: "Heron", role_hint: "npc", concept: "", tags: [], recipe: spec, source: "designed", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" };
    applyServerMessage(s, env("sprite_assets_list", { assets: [asset], used_bytes: 321, max_assets: 200, max_bytes: 5242880 }), 0);
    expect(s.auth.workshop).toMatchObject({ usedBytes: 321, maxAssets: 200, maxBytes: 5242880 });
    expect(s.auth.workshop?.assets.map((a) => a.id)).toEqual(["as_1"]);
    applyServerMessage(s, env("logged_out", {}), 0);
    expect(s.auth.workshop).toBeNull();
  });
  it("cast_state replaces the cast and leaving the room clears it", () => {
    const s = createInitialState();
    const entry = { asset_id: "as_1", owner_player_id: "p1", owner_name: "Ana", name: "Heron", role_hint: "npc", concept: "", recipe: spec, status: "pending" };
    applyServerMessage(s, env("cast_state", { entries: [entry] }), 0);
    expect(s.cast).toHaveLength(1);
    applyServerMessage(s, env("cast_state", { entries: [{ ...entry, status: "approved" }, { ...entry, asset_id: "as_2" }] }), 0);
    expect(s.cast.map((c) => c.status)).toEqual(["approved", "pending"]);
    resetRoom(s);
    expect(s.cast).toEqual([]);
  });
});
