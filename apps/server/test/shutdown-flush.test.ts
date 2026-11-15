import { designSpriteOffline } from "@aedm/engine";
import { describe, expect, it } from "vitest";
import { JsonAssetStore } from "../src/assets/store";
import type { KvBackend } from "../src/kv";
import { startHarness } from "./helpers";

/** A key-value store whose writes take a while, counting the ones still in flight. */
function slowKv(delayMs: number): KvBackend & { pending: number } {
  const map = new Map<string, string>();
  const kv = {
    pending: 0,
    async get(key: string) { return map.get(key) ?? null; },
    async put(key: string, value: string) {
      kv.pending++;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      map.set(key, value);
      kv.pending--;
    },
  };
  return kv as unknown as KvBackend & { pending: number };
}

describe("server shutdown", () => {
  it("waits for asset writes nobody awaited (a cache hit bumps a use count in the background)", async () => {
    const kv = slowKv(150);
    const assets = new JsonAssetStore({ kv });
    const h = await startHarness({ assets });
    await assets.put({
      id: "a_test", key: "k", kind: "sprite", created_at: new Date(0).toISOString(), uses: 1,
      spec: designSpriteOffline({ concept: "a marsh crow", name: "Marsh Crow", role: "bystander", kind: "npc" }, 1),
    });
    await assets.use("sprite", "k"); // starts a write and does not wait for it
    expect(kv.pending).toBe(1);
    await h.stop();
    expect(kv.pending).toBe(0);
  });
});
