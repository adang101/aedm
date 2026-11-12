import { describe, expect, it } from "vitest";
import { CHUNK_CHARS, DoKv, type StorageLike } from "../src/do-kv";

/** A Map-backed stand-in for DurableObjectStorage. */
function fakeStorage(): StorageLike & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    get: (async (k: string | string[]) => {
      if (Array.isArray(k)) return new Map(k.filter((x) => map.has(x)).map((x) => [x, map.get(x)]));
      return map.get(k);
    }) as StorageLike["get"],
    put: async (entries) => { for (const [k, v] of Object.entries(entries)) map.set(k, v); },
    delete: async (keys) => { let n = 0; for (const k of keys) if (map.delete(k)) n++; return n; },
    list: (async ({ prefix }: { prefix: string }) => new Map([...map].filter(([k]) => k.startsWith(prefix)))) as StorageLike["list"],
  };
}

describe("DoKv", () => {
  it("round-trips small, empty and multi-chunk values", async () => {
    const kv = new DoKv(fakeStorage());
    const big = "é".repeat(CHUNK_CHARS * 2 + 17);
    await kv.put("a.json", "small");
    await kv.put("empty.json", "");
    await kv.put("big.json", big);
    expect(await kv.get("a.json")).toBe("small");
    expect(await kv.get("empty.json")).toBe("");
    expect(await kv.get("big.json")).toBe(big);
    expect(await kv.get("missing.json")).toBeNull();
  });

  it("drops leftover chunks when a value shrinks", async () => {
    const st = fakeStorage();
    const kv = new DoKv(st);
    await kv.put("v.json", "x".repeat(CHUNK_CHARS * 3));
    await kv.put("v.json", "tiny");
    expect(await kv.get("v.json")).toBe("tiny");
    expect([...st.map.keys()].filter((k) => k.startsWith("d:v.json:"))).toEqual(["d:v.json:0"]);
  });

  it("lists keys by prefix without listing chunks", async () => {
    const kv = new DoKv(fakeStorage());
    await kv.put("r1/auto.json", "x");
    await kv.put("r1/s2.json", "x".repeat(CHUNK_CHARS + 1));
    await kv.put("r2/auto.json", "x");
    expect((await kv.list("r1/")).sort()).toEqual(["r1/auto.json", "r1/s2.json"]);
    expect(await kv.list()).toHaveLength(3);
  });

  it("refuses unsafe keys", async () => {
    await expect(new DoKv(fakeStorage()).put("../x", "y")).rejects.toThrow(/unsafe/);
  });
});
