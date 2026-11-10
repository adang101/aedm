import { describe, expect, it } from "vitest";
import { BODY_PLANS, MAX_SPRITE_PARTS, SpriteSpecDraftSchema, SpriteSpecSchema, inPalette, type BodyPlan, type SpriteSpecDraft } from "@aedm/schemas";
import { createRng } from "./rng.ts";
import { bodyFromText, cleanTraits, designSpriteOffline, finalizeSpriteSpec, glyphFromName, type SpriteKind } from "./sprites.ts";

const draft = (over: Partial<SpriteSpecDraft> = {}): SpriteSpecDraft =>
  SpriteSpecDraftSchema.parse({
    body: "humanoid",
    palette: { primary: "#3d2a6b", secondary: "#2f6bb5", accent: "#9fd4f5", detail: "#1b1626" },
    parts: [],
    ...over,
  });

const parts = (names: string[]) => names.map((part) => ({ part }));
const names = (spec: { parts: { part: string }[] }) => spec.parts.map((p) => p.part);

describe("finalizeSpriteSpec", () => {
  it("snaps colors to the master palette and validates", () => {
    const { spec } = finalizeSpriteSpec(draft({ palette: { primary: "#123456", secondary: "#ff0000", accent: "#00ff00", detail: "#000000" } }));
    for (const c of Object.values(spec.palette)) expect(inPalette(c)).toBe(true);
    expect(SpriteSpecSchema.safeParse(spec).success).toBe(true);
  });

  it("drops unknown parts and maps aliases", () => {
    const { spec, notes } = finalizeSpriteSpec(draft({ parts: parts(["horn", "Sword", "glowing eyes", "cape", "wizard hat", "jetpack"]) }));
    expect(names(spec)).toEqual(["horns", "sword", "glowing_eyes", "cloak", "hat"]);
    expect(notes.join(" ")).toContain("jetpack");
  });

  it("caps at 6 parts and dedupes", () => {
    const { spec } = finalizeSpriteSpec(draft({ parts: parts(["robe", "robe", "cloak", "staff", "glowing_eyes", "aura", "smoke", "sparkles", "drips", "tail"]) }));
    expect(spec.parts).toHaveLength(MAX_SPRITE_PARTS);
    expect(names(spec).filter((n) => n === "robe")).toHaveLength(1);
  });

  it("removes contradictions", () => {
    const hats = finalizeSpriteSpec(draft({ parts: parts(["hood", "hat", "helmet", "crown"]) })).spec;
    expect(names(hats)).toEqual(["hood", "crown"]);
    expect(names(finalizeSpriteSpec(draft({ parts: parts(["horns", "antlers"]) })).spec)).toEqual(["horns"]);
    expect(names(finalizeSpriteSpec(draft({ parts: parts(["robe", "armor", "cloak"]) })).spec)).toEqual(["robe", "cloak"]);
    // one item per hand: sword (right) and bow (right) clash, shield (left) is fine
    expect(names(finalizeSpriteSpec(draft({ parts: parts(["sword", "bow", "shield", "lantern"]) })).spec)).toEqual(["sword", "shield"]);
    const both = finalizeSpriteSpec(draft({ parts: [{ part: "staff", side: "both" }, { part: "shield" }] })).spec;
    expect(names(both)).toEqual(["staff"]);
  });

  it("fills glyph from name and a pose", () => {
    const { spec } = finalizeSpriteSpec(draft(), { name: "Old Marta", role: "merchant" });
    expect(spec.glyph).toBe("OM");
    expect(spec.pose).toBe("idle");
    expect(finalizeSpriteSpec(draft({ body: "spirit" }), { role: "standard" }).spec.pose).toBe("floating");
    expect(finalizeSpriteSpec(draft({ glyph: "Z" }), { name: "Old Marta" }).spec.glyph).toBe("Z");
    expect(glyphFromName("Brindle")).toBe("B");
  });

  it("clamps size by role and body", () => {
    expect(finalizeSpriteSpec(draft({ body: "beast", size: "huge" }), { role: "minion" }).spec.size).toBe("medium");
    expect(finalizeSpriteSpec(draft({ body: "humanoid", size: "huge" }), { role: "standard" }).spec.size).toBe("large");
    expect(finalizeSpriteSpec(draft({ body: "humanoid", size: "huge" }), { role: "boss" }).spec.size).toBe("huge");
    expect(finalizeSpriteSpec(draft({ body: "beast", size: "tiny" }), { role: "boss" }).spec.size).toBe("medium");
    expect(finalizeSpriteSpec(draft({ body: "beast", size: "huge" }), { role: "villain" }).spec.size).toBe("large");
  });

  it("separates primary and secondary and keeps accent apart", () => {
    const same = draft({ palette: { primary: "#4f9fe0", secondary: "#4f9fe0", accent: "#4f9fe0", detail: "#1b1626" } });
    const { spec } = finalizeSpriteSpec(same);
    expect(spec.palette.secondary).not.toBe(spec.palette.primary);
    expect(spec.palette.accent).not.toBe(spec.palette.primary);
  });

  it("cleans traits", () => {
    expect(cleanTraits("a grim figure see https://x.example/a and www.evil.com, like Gandalf")).toBe("a grim figure see and like");
    expect(cleanTraits("x ".repeat(200)).length).toBeLessThanOrEqual(160);
  });
});

describe("designSpriteOffline", () => {
  const cases: [string, BodyPlan][] = [
    ["a wolf with a torn ear", "beast"], ["a harpy of the cliffs", "avian"], ["a giant eel", "serpent"], ["a swarm-spider", "insectoid"],
    ["an acid slime", "amorphous"], ["a clockwork soldier", "construct"], ["a drowned ghost", "spirit"], ["a creeping vine thing", "plant"],
    ["a weeping statue", "object"], ["a hooded cultist", "humanoid"], ["something unspeakable", "humanoid"],
  ];
  it.each(cases)("%s -> %s", (concept, body) => {
    expect(designSpriteOffline({ concept, name: "X", role: "standard", kind: "enemy" }, 1).body).toBe(body);
  });

  it("reaches every body plan", () => {
    const seen = new Set(cases.map(([c]) => designSpriteOffline({ concept: c, name: "X", role: "standard", kind: "enemy" }, 1).body));
    for (const b of BODY_PLANS) expect(seen.has(b)).toBe(true);
  });

  it("keeps people as people when they wear animals", () => {
    expect(bodyFromText("a hunter in a wolf pelt")).toBe("humanoid");
  });

  it("picks parts from words", () => {
    const k = designSpriteOffline({ concept: "A knight", name: "Sir Orrin", role: "ally", kind: "npc" }, 3);
    expect(names(k)).toEqual(expect.arrayContaining(["helmet", "armor", "sword", "shield"]));
    const c = designSpriteOffline({ concept: "A cultist of the deep", name: "Cultist", role: "minion", kind: "enemy" }, 3);
    expect(names(c)).toEqual(expect.arrayContaining(["hood", "robe"]));
    const d = designSpriteOffline({ concept: "A drowned sailor with glowing eyes", name: "Wet Tom", role: "standard", kind: "enemy" }, 3);
    expect(names(d)).toEqual(expect.arrayContaining(["drips", "glowing_eyes"]));
    expect(names(designSpriteOffline({ concept: "A horned fire demon", name: "Cinder", role: "boss", kind: "enemy" }, 3))).toEqual(expect.arrayContaining(["horns", "flames"]));
  });

  it("palette follows mood and role, size follows role", () => {
    const water = designSpriteOffline({ concept: "a drowned fisher", name: "Fisher", role: "standard", kind: "enemy" }, 1);
    expect(["#1f3f7a", "#2f6bb5", "#4f9fe0", "#9fd4f5"]).toContain(water.palette.primary);
    const fire = designSpriteOffline({ concept: "a molten brute", name: "Brute", role: "elite", kind: "enemy" }, 1);
    expect(["#7a1f2b", "#c0392b", "#e8683a", "#f5a65b"]).toContain(fire.palette.primary);
    expect(designSpriteOffline({ concept: "a cultist", name: "C", role: "minion", kind: "enemy" }, 1).size).toBe("small");
    expect(designSpriteOffline({ concept: "a cultist leader", name: "C", role: "boss", kind: "enemy" }, 1).size).toBe("large");
    expect(designSpriteOffline({ concept: "a giant crab king", name: "C", role: "boss", kind: "enemy" }, 1).size).toBe("huge");
    expect(designSpriteOffline({ concept: "a giant crab king", name: "C", role: "minion", kind: "enemy" }, 1).size).not.toBe("huge");
  });

  it("is deterministic", () => {
    const i = { concept: "A robed priest", name: "Ansel", role: "quest_giver", kind: "npc" as const };
    expect(designSpriteOffline(i, 42)).toEqual(designSpriteOffline(i, 42));
  });

  it("is valid for 200 fuzzed concepts", () => {
    const rng = createRng(2024);
    const adj = ["drowned", "hooded", "giant", "tiny", "fiery", "ancient", "glowing", "winged", "robed", "armored", "horned", "mossy", "clockwork", "spectral", ""];
    const noun = ["wolf", "harpy", "eel", "spider", "slime", "golem", "ghost", "treant", "statue", "knight", "cultist", "witch", "priest", "archer", "king", "ferryman", "thing", "!!!", "", "ünïcödé"];
    const roles = ["minion", "standard", "elite", "boss", "merchant", "quest_giver", "ally", "bystander", "villain"];
    const kinds: SpriteKind[] = ["npc", "enemy", "pc", "prop"];
    for (let n = 0; n < 200; n++) {
      const concept = `${rng.pick(adj)} ${rng.pick(noun)} with ${rng.pick(adj)} ${rng.pick(noun)} ${"x".repeat(rng.int(0, 150))}`;
      const spec = designSpriteOffline(
        { concept, appearance: rng.next() < 0.5 ? concept.slice(0, 160) : undefined, name: rng.pick(["", "Bob", "Old Marta", "Ünï"]), role: rng.pick(roles), kind: rng.pick(kinds) },
        rng.int(1, 1e9),
      );
      const r = SpriteSpecSchema.safeParse(spec);
      expect(r.success, `${concept}: ${JSON.stringify(r)}`).toBe(true);
      for (const c of Object.values(spec.palette)) expect(inPalette(c)).toBe(true);
      expect(spec.parts.length).toBeLessThanOrEqual(MAX_SPRITE_PARTS);
    }
  });
});
