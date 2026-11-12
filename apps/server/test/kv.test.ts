import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FsKv, MemoryKv, type KvBackend } from "../src/kv";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

async function backends(): Promise<[string, KvBackend][]> {
  const dir = await mkdtemp(join(tmpdir(), "aedm-kv-"));
  dirs.push(dir);
  return [["fs", new FsKv(dir)], ["memory", new MemoryKv()]];
}

describe("KvBackend", () => {
  it("round-trips values, replaces them, and returns null for a missing key", async () => {
    for (const [, kv] of await backends()) {
      expect(await kv.get("a/b.json")).toBeNull();
      await kv.put("a/b.json", "one");
      await kv.put("a/b.json", "two");
      expect(await kv.get("a/b.json")).toBe("two");
    }
  });

  it("lists keys by prefix, nested keys included", async () => {
    for (const [, kv] of await backends()) {
      await kv.put("r1/auto.json", "x");
      await kv.put("r1/s2.json", "x");
      await kv.put("r2/auto.json", "x");
      await kv.put("users.json", "x");
      expect((await kv.list("r1/")).sort()).toEqual(["r1/auto.json", "r1/s2.json"]);
      expect((await kv.list()).sort()).toEqual(["r1/auto.json", "r1/s2.json", "r2/auto.json", "users.json"]);
    }
  });

  it("refuses keys that could escape the folder", async () => {
    for (const [, kv] of await backends()) {
      for (const bad of ["../x", "a/../b", "/abs", "a//b", "", "a b", "a/."]) {
        await expect(kv.put(bad, "x")).rejects.toThrow(/unsafe/);
        await expect(kv.get(bad)).rejects.toThrow(/unsafe/);
      }
    }
  });

  it("FsKv lays keys out as plain files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aedm-kv-"));
    dirs.push(dir);
    await new FsKv(dir).put("room_1/autosave.json", "{}");
    expect(await readFile(join(dir, "room_1", "autosave.json"), "utf8")).toBe("{}");
  });
});

describe("KvSaveStore", () => {
  const save = (owner: string | null, name = "x") => ({
    v: 1 as const, name, saved_at: "2026-01-01T00:00:00.000Z", owner_user_id: owner,
    room: { room_id: "r", invite_code: "ABCDEF", settings: {} as never, players: [{ player_id: "p", display_name: "Ana", character_id: null }] },
    state: { campaignId: "c1", bible: { title: "T" } } as never, turns: [], summaries: [], scene_note: "", dm_notes: [],
  });

  it("writes, reads exactly, falls back to another room's folder, and lists only the owner's saves", async () => {
    const { KvSaveStore } = await import("../src/saves");
    const store = new KvSaveStore(new MemoryKv());
    await store.write("room_1", "autosave", save("u1", "auto"));
    await store.write("room_2", "sv_1", save("u2"));
    expect((await store.readExact("room_1", "autosave"))?.name).toBe("auto");
    expect(await store.readExact("room_2", "autosave")).toBeNull();
    expect((await store.read("room_1", "sv_1"))?.owner_user_id).toBe("u2");
    expect((await store.listOwned("u1")).map((c) => c.save_id)).toEqual(["autosave"]);
    expect(await store.listOwned("nobody")).toEqual([]);
    await expect(store.write("../x", "a", save(null))).rejects.toThrow(/unsafe/);
  });
});
