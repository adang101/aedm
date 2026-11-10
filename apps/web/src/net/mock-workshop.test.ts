import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WS_VERSION, ServerMessageSchema, type ServerMessage } from "@aedm/schemas";
import { designSpriteOffline } from "@aedm/engine";
import { MockServer } from "./mock";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

async function session() {
  const got: ServerMessage[] = [];
  const mock = new MockServer();
  const t = mock.factory({ onOpen: () => undefined, onClose: () => undefined, onMessage: (raw) => { got.push(ServerMessageSchema.parse(JSON.parse(raw))); } });
  await vi.advanceTimersByTimeAsync(200);
  let n = 0;
  const ask = async (type: string, payload: unknown) => {
    const id = `m${++n}`;
    t.send(JSON.stringify({ v: WS_VERSION, type, id, ts: 1, payload }));
    await vi.advanceTimersByTimeAsync(200);
    return got.find((m) => m.ack_id === id);
  };
  return { got, mock, ask, close: () => t.close() };
}
const recipe = designSpriteOffline({ concept: "a heron ferryman", name: "Heron", role: "npc", kind: "npc" }, 3);
const save = (over: Record<string, unknown> = {}) => ({ name: "Heron", role_hint: "npc", concept: "a ferryman", tags: [], recipe, source: "designed", ...over });

describe("mock server: Workshop and cast", () => {
  it("guests are told to log in", async () => {
    const s = await session();
    const r = await s.ask("list_sprite_assets", {});
    expect(r?.type === "error" && r.payload.message).toContain("Log in");
    s.close();
  });

  it("saves, updates and deletes in the account's Workshop", async () => {
    const s = await session();
    await s.ask("register", { username: "ana_1", password: "a-long-password", display_name: "Ana" });
    const a = await s.ask("save_sprite_asset", save());
    expect(a?.type === "sprite_assets_list" && a.payload.assets).toHaveLength(1);
    const id = a?.type === "sprite_assets_list" ? a.payload.assets[0]!.id : "";
    const b = await s.ask("save_sprite_asset", save({ id, name: "Heron II" }));
    expect(b?.type === "sprite_assets_list" && b.payload.assets.map((x) => x.name)).toEqual(["Heron II"]);
    const gone = await s.ask("delete_sprite_asset", { id });
    expect(gone?.type === "sprite_assets_list" && gone.payload.assets).toEqual([]);
    const again = await s.ask("delete_sprite_asset", { id });
    expect(again?.type).toBe("error");
    s.close();
  });

  it("the host's own offers join the cast at once; a fake player's wait for approval", async () => {
    const s = await session();
    await s.ask("register", { username: "ana_2", password: "a-long-password", display_name: "Ana" });
    const w = await s.ask("save_sprite_asset", save());
    const id = w?.type === "sprite_assets_list" ? w.payload.assets[0]!.id : "";
    await s.ask("create_room", { display_name: "Ana" });
    await s.ask("join_room", { invite_code: "K7M2QD", display_name: "Ana" });
    const off = await s.ask("offer_to_cast", { asset_id: id });
    expect(off?.type).toBe("presence");
    const casts = () => s.got.filter((m) => m.type === "cast_state");
    const last = () => { const l = casts(); const m = l[l.length - 1]; return m?.type === "cast_state" ? m.payload.entries : []; };
    expect(last().map((e) => e.status)).toEqual(["approved"]);

    s.mock.simulateOffer();
    await vi.advanceTimersByTimeAsync(200);
    expect(last().map((e) => e.status)).toEqual(["approved", "pending"]);
    const pendingId = last()[1]!.asset_id;
    await s.ask("cast_decision", { asset_id: pendingId, approve: true });
    expect(last().every((e) => e.status === "approved")).toBe(true);
    await s.ask("cast_decision", { asset_id: pendingId, approve: false });
    expect(last()).toHaveLength(1);

    const closed = await s.ask("update_settings", { custom_cast: "off" });
    expect(closed?.type).toBe("presence");
    const refused = await s.ask("offer_to_cast", { asset_id: "as_x" });
    expect(refused?.type === "error" && refused.payload.code).toBe("forbidden");
    s.close();
  });
});
