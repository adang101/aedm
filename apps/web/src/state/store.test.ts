import type { EntityView, ServerMessage } from "@aedm/schemas";
import { describe, expect, it } from "vitest";
import { applyServerMessage, createInitialState, myEntity } from "./store";

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
