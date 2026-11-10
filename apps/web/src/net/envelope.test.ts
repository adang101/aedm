import { ClientMessageSchema, WS_VERSION } from "@aedm/schemas";
import { describe, expect, it } from "vitest";
import { AckTracker, backoffDelay, createIdGenerator, makeEnvelope } from "./envelope";

describe("envelope", () => {
  it("builds a message the shared schema accepts", () => {
    const next = createIdGenerator("abc");
    const env = makeEnvelope("say", { text: "hello", channel: "ic" }, next(), 1234);
    expect(env).toMatchObject({ v: WS_VERSION, type: "say", id: "c-abc-1", ts: 1234 });
    expect(ClientMessageSchema.safeParse(env).success).toBe(true);
    expect(ClientMessageSchema.safeParse(makeEnvelope("say", { text: "", channel: "ic" }, "x", 1)).success).toBe(false);
  });

  it("ids are unique within a session", () => {
    const next = createIdGenerator("n");
    const ids = new Set(Array.from({ length: 100 }, next));
    expect(ids.size).toBe(100);
  });

  it("backoff grows, caps at 10s and jitters", () => {
    expect(backoffDelay(0, 1)).toBe(500);
    expect(backoffDelay(1, 1)).toBe(1000);
    expect(backoffDelay(30, 1)).toBe(10_000);
    expect(backoffDelay(30, 0)).toBe(5000);
  });

  it("tracks acks", () => {
    const t = new AckTracker();
    t.track("a", "say", 0);
    t.track("b", "ping", 5000);
    expect(t.size).toBe(2);
    expect(t.ack("a")?.type).toBe("say");
    expect(t.ack("a")).toBeUndefined();
    expect(t.expire(70_000, 60_000)).toBe(1);
    expect(t.size).toBe(0);
  });
});
