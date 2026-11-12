import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findFreeTileNear, occupiedTiles, type GameState } from "@aedm/engine";
import { createFakeProvider, type ModelProvider } from "@aedm/llm";
import { SpriteSpecSchema, type AssetRecord } from "@aedm/schemas";
import { JsonAssetStore, MemoryAssetStore, assetKey } from "../src/assets/store";
import { dmReply, scriptedProvider, sleep, startedTable, startHarness, type Harness, type Table, type TestClient } from "./helpers";

let h: Harness | undefined;
afterEach(async () => { await h?.stop(); h = undefined; });

const stateOf = (harness: Harness): GameState => harness.server.rooms.all()[0]!.game!.state;

async function beat(t: Table, a = "I wait.", b = "I wait too."): Promise<void> {
  const say = (c: TestClient, text: string) => c.send("say", { text, channel: "ic" });
  say(t.a, a);
  say(t.b, b);
}

async function until(pred: () => boolean, ms = 4000): Promise<void> {
  for (let i = 0; i < ms / 20 && !pred(); i++) await sleep(20);
  expect(pred()).toBe(true);
}

/** Scripted DM, but sprite requests are handled by `onSprite`. */
function withSprites(onSprite: () => Promise<string>): ModelProvider & { queueDm: (...r: string[]) => void; spriteCalls: () => number } {
  const base = scriptedProvider();
  let n = 0;
  const p = {
    name: "sprite-test",
    queueDm: base.queueDm,
    spriteCalls: () => n,
    async complete(req: Parameters<ModelProvider["complete"]>[0], o?: Parameters<ModelProvider["complete"]>[1]) {
      if (req.purpose === "sprite") {
        n++;
        return { text: await onSprite(), model: "x" };
      }
      return base.complete(req, o);
    },
  };
  return p;
}

const enemyActions = (mapId: string, x: number, y: number, extra: Record<string, unknown> = {}) => [
  { type: "create_enemy", concept: "A drowned sailor with glowing eyes", appearance: "pale, waterlogged coat, dripping", role: "standard", setting_notes: "", ref: "en_sailor", ...extra },
  { type: "spawn_entity", archetype_id: "en_sailor", map_id: mapId, x, y, count: 1 },
];

describe("sprites in the game", () => {
  it("create_enemy with appearance: spawned entities carry the designed spec; a repeat concept reuses the cached asset", async () => {
    const provider = scriptedProvider();
    const assets = new MemoryAssetStore();
    h = await startHarness({ provider, assets });
    const t = await startedTable(h);
    const snap = t.a.lastSnapshot()!;
    const pc = snap.entities.find((e) => e.kind === "pc")!;
    provider.queueDm(dmReply(enemyActions(snap.map.id, pc.x + 2, pc.y + 2)));
    await beat(t);
    await until(() => Object.values(stateOf(h!).entities).filter((e) => e.kind === "enemy").length === 1);
    const enemies = Object.values(stateOf(h).entities).filter((e) => e.kind === "enemy");
    for (const e of enemies) {
      expect(e.sprite.kind).toBe("spec");
      expect(SpriteSpecSchema.safeParse(e.sprite).success).toBe(true);
    }
    const arch = stateOf(h).archetypes["en_sailor"]!;
    expect(arch.sprite).toBeTruthy();
    expect(arch.appearance).toBe("pale, waterlogged coat, dripping");
    expect(enemies[0]!.sprite).toEqual(arch.sprite);
    // the snapshot a client receives has the spec too
    expect(t.a.invalid).toEqual([]);

    // same concept and appearance, another ref: same look, asset used twice
    provider.queueDm(dmReply([{ type: "create_enemy", concept: "a  drowned SAILOR with glowing eyes", appearance: "pale, waterlogged coat, dripping", role: "elite", setting_notes: "", ref: "en_sailor2" }]));
    await beat(t);
    await until(() => !!stateOf(h!).archetypes["en_sailor2"]);
    expect(stateOf(h).archetypes["en_sailor2"]!.sprite).toEqual(arch.sprite);
    const list = await assets.list("sprite");
    expect(list).toHaveLength(1);
    expect(list[0]!.uses).toBe(2);
  });

  it("create_npc gets a spec sprite", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    const st = stateOf(h);
    const map = st.maps[st.currentMapId as string]!;
    const pc = Object.values(st.entities).find((e) => e.kind === "pc")!;
    const spot = findFreeTileNear(map, pc.x + 2, pc.y + 2, occupiedTiles(st, map.id))!;
    provider.queueDm(dmReply([{ type: "create_npc", name: "Old Marta", concept: "A robed ferry keeper", role: "merchant", map_id: map.id, x: spot.x, y: spot.y, sprite_tags: ["robe"], appearance: "hooded, carries a lantern" }]));
    await beat(t);
    await until(() => Object.values(stateOf(h!).entities).some((e) => e.kind === "npc"));
    const npc = Object.values(stateOf(h).entities).find((e) => e.kind === "npc")!;
    expect(npc.sprite.kind).toBe("spec");
    if (npc.sprite.kind === "spec") {
      expect(npc.sprite.parts.map((p) => p.part)).toEqual(expect.arrayContaining(["hood"]));
      expect(npc.sprite.glyph).toBeTruthy();
    }
    expect(Object.values(stateOf(h).npcs)[0]!.appearance).toBe("hooded, carries a lantern");
  });

  it("a failing sprite model falls back to the offline designer, and the fallback is not cached", async () => {
    const provider = withSprites(async () => { throw new Error("model down"); });
    const assets = new MemoryAssetStore();
    h = await startHarness({ provider, assets });
    const t = await startedTable(h);
    const snap = t.a.lastSnapshot()!;
    const pc = snap.entities.find((e) => e.kind === "pc")!;
    provider.queueDm(dmReply(enemyActions(snap.map.id, pc.x + 2, pc.y + 2)));
    await beat(t);
    await until(() => Object.values(stateOf(h!).entities).filter((e) => e.kind === "enemy").length === 1);
    const arch = stateOf(h).archetypes["en_sailor"]!;
    expect(arch.sprite?.kind).toBe("spec");
    expect(arch.sprite?.kind === "spec" && arch.sprite.parts.map((p) => p.part)).toEqual(expect.arrayContaining(["drips", "glowing_eyes"]));
    expect(provider.spriteCalls()).toBeGreaterThan(0);
    expect(await assets.list("sprite")).toHaveLength(0);
  });

  it("a hanging sprite model times out to the offline designer instead of blocking the game", async () => {
    const provider = withSprites(() => new Promise<string>(() => { /* never answers */ }));
    h = await startHarness({ provider, spriteTimeoutMs: 80 });
    const t = await startedTable(h);
    const snap = t.a.lastSnapshot()!;
    const pc = snap.entities.find((e) => e.kind === "pc")!;
    provider.queueDm(dmReply(enemyActions(snap.map.id, pc.x + 2, pc.y + 2)));
    await beat(t);
    await until(() => Object.values(stateOf(h!).entities).filter((e) => e.kind === "enemy").length === 1, 5000);
    expect(stateOf(h).archetypes["en_sailor"]!.sprite?.kind).toBe("spec");
  });

  it("a character without a recipe is given a designed spec when claimed", async () => {
    h = await startHarness();
    const a = await h.connect();
    await a.createAndJoin("Alice");
    const { sprite_recipe: _drop, ...noLook } = (await import("./helpers")).brindle();
    const r = await a.request("claim_character", { character_id: "new", character: noLook });
    expect(r.type).toBe("character_claimed");
    const lobby = h.server.rooms.all()[0]!.scratch;
    const ch = Object.values(lobby.characters)[0]!;
    expect(ch.sprite_recipe.kind).toBe("spec");
  });
});

describe("asset store", () => {
  const record = (key: string): AssetRecord => ({
    id: `as_${key.slice(0, 8)}`, key, kind: "sprite", created_at: "2026-01-01T00:00:00.000Z", uses: 1,
    spec: {
      kind: "spec", v: 1, body: "beast", size: "medium", traits: "",
      palette: { primary: "#4f8a3c", secondary: "#70472f", accent: "#e8c95a", detail: "#1b1626" }, parts: [{ part: "fur" }],
    },
  });

  it("keys on normalized concept and appearance", () => {
    expect(assetKey("sprite", "A  Wolf ", "grey")).toBe(assetKey("sprite", "a wolf", " GREY"));
    expect(assetKey("sprite", "a wolf", "grey")).not.toBe(assetKey("sprite", "a wolf", "black"));
    expect(assetKey("sprite", "a wolf")).not.toBe(assetKey("material", "a wolf"));
  });

  it("persists to assets.json, counts uses, and survives a reload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aedm-assets-"));
    try {
      const key = assetKey("sprite", "a wolf");
      const s1 = new JsonAssetStore({ dir: join(dir, "assets") });
      await s1.put(record(key));
      expect((await s1.use("sprite", key))?.uses).toBe(2);
      await s1.flush();
      const s2 = new JsonAssetStore({ dir: join(dir, "assets") });
      const list = await s2.list("sprite");
      expect(list).toHaveLength(1);
      expect(list[0]!.uses).toBe(2);
      expect((await s2.use("sprite", key))?.uses).toBe(3);
      expect(await s2.use("sprite", "nope")).toBeNull();
      expect(await s2.list("material")).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores a corrupt file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aedm-assets-"));
    try {
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(join(dir, "assets"));
      await writeFile(join(dir, "assets", "assets.json"), "{not json");
      expect(await new JsonAssetStore({ dir: join(dir, "assets") }).list()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("the default fake provider designs sprites offline too", async () => {
    const p = createFakeProvider();
    const r = await p.complete({ tier: "fast", system: "s", messages: [{ role: "user", content: "<concept>\na wolf\n</concept>\n<appearance>\n\n</appearance>\n<role>\nenemy\n</role>" }], purpose: "sprite" });
    expect(JSON.parse(r.text).body).toBe("beast");
  });
});
