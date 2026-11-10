import { describe, expect, it } from "vitest";
import { SpriteSpecSchema, type SpriteSpec, type SpriteSpecDraft } from "@aedm/schemas";
import { createFakeProvider } from "./providers/fake";
import { designSprite, type SpriteDesignDeps } from "./sprite";

const input = { concept: "A drowned sailor", appearance: "waterlogged coat", name: "Wet Tom", role: "standard", kind: "enemy" as const };

const good = JSON.stringify({
  body: "humanoid", size: "medium",
  palette: { primary: "#2f6bb5", secondary: "#5c6380", accent: "#9fd4f5", detail: "#1b1626" },
  parts: [{ part: "robe" }, { part: "drips" }],
  traits: "pale sailor",
});

const stub = (spec: Partial<SpriteSpec> = {}): SpriteSpec => ({
  kind: "spec", v: 1, body: "beast", size: "small", traits: "", palette: { primary: "#4f8a3c", secondary: "#70472f", accent: "#e8c95a", detail: "#1b1626" },
  parts: [], ...spec,
});

const deps = (calls: string[] = []): SpriteSpecDraftDeps => ({
  finalize: (draft: SpriteSpecDraft, ctx) => {
    calls.push(`finalize:${ctx.role}:${ctx.name}`);
    return { spec: stub({ body: draft.body, size: draft.size }), notes: ["finalized"] };
  },
  fallback: () => { calls.push("fallback"); return stub({ body: "serpent" }); },
});
type SpriteSpecDraftDeps = SpriteDesignDeps;

describe("designSprite", () => {
  it("uses a good draft (fast tier, sprite purpose, finalized)", async () => {
    const provider = createFakeProvider([good]);
    const calls: string[] = [];
    const r = await designSprite(provider, input, deps(calls));
    expect(r.source).toBe("model");
    expect(r.notes).toEqual(["finalized"]);
    expect(r.spec.body).toBe("humanoid");
    expect(calls).toEqual(["finalize:standard:Wet Tom"]);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.tier).toBe("fast");
    expect(provider.requests[0]!.purpose).toBe("sprite");
    expect(provider.requests[0]!.messages[0]!.content).toContain("waterlogged coat");
  });

  it("bad then good: one repair call", async () => {
    const provider = createFakeProvider(['{"body":"blob"}', good]);
    const r = await designSprite(provider, input, deps());
    expect(r.source).toBe("model");
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]!.purpose).toBe("repair");
  });

  it("bad twice: offline fallback, never a third call", async () => {
    const provider = createFakeProvider(["nope", '{"body":"blob"}', good]);
    const calls: string[] = [];
    const r = await designSprite(provider, input, deps(calls));
    expect(r.source).toBe("offline");
    expect(r.spec.body).toBe("serpent");
    expect(calls).toEqual(["fallback"]);
    expect(provider.requests).toHaveLength(2);
    expect(provider.remaining).toBe(1);
  });

  it("provider error: offline fallback", async () => {
    const provider = createFakeProvider([new Error("boom")]);
    const r = await designSprite(provider, input, deps());
    expect(r.source).toBe("offline");
  });

  it("the unscripted fake returns a schema-valid draft for the sprite request", async () => {
    const provider = createFakeProvider();
    let draft: SpriteSpecDraft | undefined;
    const r = await designSprite(provider, { ...input, concept: "a hooded cultist with a staff" }, {
      finalize: (d) => { draft = d; return { spec: stub(), notes: [] }; },
      fallback: () => stub(),
    });
    expect(r.source).toBe("model");
    expect(draft?.parts.map((p) => p.part)).toEqual(expect.arrayContaining(["hood", "staff"]));
    expect(SpriteSpecSchema.safeParse(r.spec).success).toBe(true);
  });
});
