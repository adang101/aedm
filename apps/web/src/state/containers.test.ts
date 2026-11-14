import type { ContainerSummary, EntityView, GameMap, ServerMessage } from "@aedm/schemas";
import { describe, expect, it } from "vitest";
import { shouldClose, viewIsStale } from "../ui/container";
import { applyServerMessage, containerAt, createInitialState, resetRoom, type AppState } from "./store";

const sprite = { kind: "shape", shape: "circle", color: "#4f8a3c", accent: "#f6e8a0", glyph: "A" } as const;
const ent = (id: string, x: number, y: number, extra: Partial<EntityView> = {}): EntityView => ({
  id, kind: "pc", name: id, x, y, hp: 10, hp_max: 10, conditions: [], sprite, ...extra,
});
let n = 0;
const msg = <T extends ServerMessage["type"]>(type: T, payload: Extract<ServerMessage, { type: T }>["payload"]) =>
  ({ v: 7, type, id: `s${++n}`, ts: 0, payload }) as unknown as ServerMessage;

const map = (id = "m_x"): GameMap => ({
  v: 2, id, width: 20, height: 20, layers: [{
    type: "objectgroup", name: "objects", objects: [
      { type: "interactable", id: "door_a", kind: "door", state: "locked", x: 3, y: 3 },
      { type: "interactable", id: "chest_a", kind: "chest", state: "closed", x: 5, y: 5 },
    ],
  }],
} as unknown as GameMap);

const chest: ContainerSummary = { id: "cn_1", kind: "chest", x: 5, y: 5, item_count: 2, locked: false, open: false, object_id: "chest_a" };
const pile: ContainerSummary = { id: "cn_2", kind: "pile", x: 7, y: 7, item_count: 1, locked: false, open: false };

function game(): AppState {
  const s = createInitialState();
  applyServerMessage(s, msg("joined", { player_id: "p1", auth_token: "t", room_id: "r" }), 0);
  applyServerMessage(s, msg("state_snapshot", {
    seq: 1, mode: "exploration", entities: [ent("a", 5, 6, { owner_player_id: "p1" })], party: [], quests: [], map: map(), containers: [chest, pile],
  }), 0);
  return s;
}

const stateOf = (s: AppState, id: string) => {
  const l = s.map!.layers[0]!;
  return l.type === "objectgroup" ? l.objects.find((o) => o.type === "interactable" && o.id === id) : undefined;
};

describe("containers in the store", () => {
  it("indexes snapshot containers and finds them by tile", () => {
    const s = game();
    expect(Object.keys(s.containers).sort()).toEqual(["cn_1", "cn_2"]);
    expect(containerAt(s, 7, 7)?.id).toBe("cn_2");
    expect(containerAt(s, 0, 0)).toBeNull();
  });

  it("keeps a snapshot without containers empty", () => {
    const s = game();
    applyServerMessage(s, msg("state_snapshot", { seq: 2, mode: "exploration", entities: [], party: [], quests: [], map: map() }), 0);
    expect(s.containers).toEqual({});
  });

  it("applies containers_changed and containers_removed", () => {
    const s = game();
    applyServerMessage(s, msg("state_diff", { seq: 2, changed: [], removed: [], containers_changed: [{ ...chest, item_count: 1, open: true }, { ...pile, id: "cn_3", x: 1, y: 1 }], containers_removed: ["cn_2"] }), 0);
    expect(s.containers.cn_1).toMatchObject({ item_count: 1, open: true });
    expect(s.containers.cn_2).toBeUndefined();
    expect(s.containers.cn_3).toBeDefined();
  });

  it("applies interactables_changed to the loaded map in place and ignores other maps", () => {
    const s = game();
    const before = s.map;
    applyServerMessage(s, msg("state_diff", { seq: 2, changed: [], removed: [], interactables_changed: [
      { map_id: "m_x", id: "door_a", state: "open" }, { map_id: "m_other", id: "chest_a", state: "open" },
    ] }), 0);
    expect(s.map).toBe(before);
    expect(stateOf(s, "door_a")).toMatchObject({ state: "open" });
    expect(stateOf(s, "chest_a")).toMatchObject({ state: "closed" });
  });

  it("stores a container_view and drops it on a new map or when leaving", () => {
    const s = game();
    applyServerMessage(s, msg("container_view", { container_id: "cn_1", kind: "chest", items: [{ id: "it_1", name: "Ring", kind: "trinket", value: 5 }], locked: false }), 0);
    expect(s.containerView?.items).toHaveLength(1);
    applyServerMessage(s, msg("state_snapshot", { seq: 2, mode: "exploration", entities: [], party: [], quests: [], map: map(), containers: [chest] }), 0);
    expect(s.containerView).not.toBeNull(); // same map: keep it open
    applyServerMessage(s, msg("state_snapshot", { seq: 3, mode: "exploration", entities: [], party: [], quests: [], map: map("m_y"), containers: [] }), 0);
    expect(s.containerView).toBeNull();
    s.containerView = { container_id: "cn_1", kind: "chest", items: [], locked: false };
    resetRoom(s);
    expect(s.containerView).toBeNull();
    expect(s.containers).toEqual({});
  });
});

describe("container panel rules", () => {
  const open = (s: AppState, id = "cn_1", count = 2, locked = false) => {
    s.containerView = { container_id: id, kind: "chest", items: Array.from({ length: count }, (_, i) => ({ id: `it_${i}`, name: "Thing", kind: "trinket" as const, value: 1 })), locked };
  };

  it("stays open while I am next to it and closes when I walk away", () => {
    const s = game();
    open(s);
    expect(shouldClose(s, true)).toBe(false);
    s.entities.a = ent("a", 5, 9, { owner_player_id: "p1" });
    expect(shouldClose(s, true)).toBe(true);
  });

  it("closes when the container vanishes, but not before its summary was ever seen", () => {
    const s = game();
    open(s, "cn_9");
    expect(shouldClose(s, false)).toBe(false);
    expect(shouldClose(s, true)).toBe(true);
  });

  it("asks for a refresh when the summary no longer matches the view", () => {
    const s = game();
    open(s);
    expect(viewIsStale(s)).toBe(false);
    applyServerMessage(s, msg("state_diff", { seq: 2, changed: [], removed: [], containers_changed: [{ ...chest, item_count: 1 }] }), 0);
    expect(viewIsStale(s)).toBe(true);
    open(s, "cn_1", 1, true);
    expect(viewIsStale(s)).toBe(true); // lock state differs
  });
});
