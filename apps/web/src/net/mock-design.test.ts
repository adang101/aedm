import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpriteSpecSchema, WS_VERSION, ServerMessageSchema, type ServerMessage } from "@aedm/schemas";
import { MockServer } from "./mock";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("mock server: design_sprite", () => {
  it("answers with a valid offline design that follows the keywords", async () => {
    const got: ServerMessage[] = [];
    const mock = new MockServer();
    const t = mock.factory({ onOpen: () => undefined, onClose: () => undefined, onMessage: (raw) => { got.push(ServerMessageSchema.parse(JSON.parse(raw))); } });
    await vi.advanceTimersByTimeAsync(200);
    t.send(JSON.stringify({ v: WS_VERSION, type: "design_sprite", id: "d1", ts: 1, payload: { prompt: "a heron with a lantern", role_hint: "pc", seed: 9 } }));
    await vi.advanceTimersByTimeAsync(300);
    const r = got.find((m) => m.ack_id === "d1");
    expect(r?.type).toBe("sprite_designed");
    if (r?.type === "sprite_designed") {
      expect(SpriteSpecSchema.safeParse(r.payload.spec).success).toBe(true);
      expect(r.payload.spec.body).toBe("avian");
      expect(r.payload.source).toBe("offline");
    }
    t.close();
  });
});
