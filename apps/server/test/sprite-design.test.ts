import { afterEach, describe, expect, it } from "vitest";
import { createFakeProvider, type ModelProvider } from "@aedm/llm";
import { SpriteSpecSchema } from "@aedm/schemas";
import { startHarness, type Harness } from "./helpers";

let h: Harness | undefined;
afterEach(async () => { await h?.stop(); h = undefined; });

const SECRET = "sk-ant-SECRET-DO-NOT-ECHO";
const failing: ModelProvider = { name: "down", async complete() { throw new Error(`boom ${SECRET}`); } };

describe("design_sprite", () => {
  it("answers a prompt with a valid spec, without joining a room", async () => {
    const provider = createFakeProvider();
    h = await startHarness({ provider });
    const c = await h.connect();
    const r = await c.request("design_sprite", { prompt: "a lanky heron-folk ferryman with a lantern", role_hint: "npc", name: "Ferryman" });
    expect(r.type).toBe("sprite_designed");
    if (r.type !== "sprite_designed") return;
    expect(SpriteSpecSchema.safeParse(r.payload.spec).success).toBe(true);
    expect(["model", "offline"]).toContain(r.payload.source);
    expect(provider.requests.filter((q) => q.purpose === "sprite")).toHaveLength(1);
    expect(r.payload.spec.glyph).toBe("F");
  });

  it("falls back to the offline keyword designer and never echoes the error", async () => {
    h = await startHarness({ provider: failing });
    const c = await h.connect();
    const r = await c.request("design_sprite", { prompt: "a heron with a lantern", role_hint: "npc", seed: 5 });
    expect(r.type).toBe("sprite_designed");
    if (r.type !== "sprite_designed") return;
    expect(r.payload.source).toBe("offline");
    expect(r.payload.spec.body).toBe("avian");
    expect(r.payload.spec.parts.map((p) => p.part)).toContain("lantern");
    expect(JSON.stringify(r.payload)).not.toContain(SECRET);
  });

  it("a new seed can change the offline look, and the same seed repeats it", async () => {
    h = await startHarness({ provider: failing, config: { limits: { spriteDesign: { max: 100, windowMs: 60_000 } } } });
    const c = await h.connect();
    const ask = async (seed: number) => {
      const r = await c.request("design_sprite", { prompt: "a wanderer in a coat", role_hint: "pc", seed });
      if (r.type !== "sprite_designed") throw new Error("no design");
      return JSON.stringify(r.payload.spec);
    };
    expect(await ask(1)).toBe(await ask(1));
    const looks = new Set([await ask(1), await ask(2), await ask(3), await ask(4), await ask(5)]);
    expect(looks.size).toBeGreaterThan(1);
  });

  it("is not cached: two identical prompts both reach the designer", async () => {
    const provider = createFakeProvider();
    h = await startHarness({ provider });
    const c = await h.connect();
    await c.request("design_sprite", { prompt: "a wolf", role_hint: "enemy" });
    await c.request("design_sprite", { prompt: "a wolf", role_hint: "enemy" });
    expect(provider.requests.filter((q) => q.purpose === "sprite")).toHaveLength(2);
  });

  it("rate limits per connection and answers with rate_limited", async () => {
    h = await startHarness({ provider: failing, config: { limits: { spriteDesign: { max: 2, windowMs: 60_000 } } } });
    const c = await h.connect();
    const a = await c.request("design_sprite", { prompt: "a wolf", role_hint: "enemy" });
    const b = await c.request("design_sprite", { prompt: "a bear", role_hint: "enemy" });
    const limited = await c.request("design_sprite", { prompt: "a fox", role_hint: "enemy" });
    expect([a.type, b.type]).toEqual(["sprite_designed", "sprite_designed"]);
    expect(limited.type).toBe("error");
    if (limited.type === "error") expect(limited.payload.code).toBe("rate_limited");
    // another connection (a different guest) has its own allowance
    const d = await h.connect();
    expect((await d.request("design_sprite", { prompt: "a fox", role_hint: "enemy" })).type).toBe("sprite_designed");
  });

  it("shares the allowance across one account's connections", async () => {
    h = await startHarness({ provider: failing, config: { limits: { spriteDesign: { max: 2, windowMs: 60_000 } } } });
    const a = await h.connect();
    const reg = await a.request("register", { username: "ferry", password: "correct horse", display_name: "Ferry" });
    expect(reg.type).toBe("auth_ok");
    if (reg.type !== "auth_ok") return;
    const b = await h.connect();
    expect((await b.request("resume_session", { session_token: reg.payload.session_token })).type).toBe("auth_ok");
    expect((await a.request("design_sprite", { prompt: "a wolf", role_hint: "pc" })).type).toBe("sprite_designed");
    expect((await b.request("design_sprite", { prompt: "a wolf", role_hint: "pc" })).type).toBe("sprite_designed");
    const third = await a.request("design_sprite", { prompt: "a wolf", role_hint: "pc" });
    expect(third.type).toBe("error");
  });

  it("rejects bad payloads", async () => {
    h = await startHarness();
    const c = await h.connect();
    for (const payload of [{ prompt: "", role_hint: "npc" }, { prompt: "x".repeat(301), role_hint: "npc" }, { prompt: "x", role_hint: "boss" }]) {
      const r = await c.request("design_sprite", payload);
      expect(r.type).toBe("error");
      if (r.type === "error") expect(r.payload.code).toBe("bad_message");
    }
  });
});
