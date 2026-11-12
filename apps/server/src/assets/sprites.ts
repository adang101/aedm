import { designSpriteOffline, finalizeSpriteSpec, type SpriteDesignInput } from "@aedm/engine";
import { designSprite, type ModelProvider } from "@aedm/llm";
import type { AssetKind, AssetRecord, SpriteSpec } from "@aedm/schemas";
import type { Logger, Timers } from "../types";
import { assetIdFromKey, assetKey, type AssetStore } from "./store";

export interface SpriteAssets {
  /** Cached spec for this concept (uses incremented), or a freshly designed one (stored unless it came from the offline fallback). */
  getOrCreateSprite(input: SpriteDesignInput): Promise<{ spec: SpriteSpec; cached: boolean; source: "cache" | "model" | "offline" }>;
  /**
   * A fresh design for a player's own prompt: never read from or written to the cache (a re-roll must differ),
   * same timeout and offline fallback. `seed` varies the offline look. Never throws.
   */
  designFresh(input: SpriteDesignInput, seed: number): Promise<{ spec: SpriteSpec; notes: string[]; source: "model" | "offline" }>;
  /** Debugging: every stored asset of a kind. */
  listAssets(kind?: AssetKind): Promise<AssetRecord[]>;
}

export interface SpriteAssetsOptions {
  store: AssetStore;
  provider: ModelProvider;
  timers: Timers;
  clock: () => number;
  logger: Logger;
  /** The sprite model is given this long, then the offline designer answers. Default 4000. */
  timeoutMs?: number;
}

const seedOf = (key: string): number => (parseInt(key.slice(0, 8), 16) & 0x7fffffff) || 1;

export function createSpriteAssets(opts: SpriteAssetsOptions): SpriteAssets {
  const timeoutMs = opts.timeoutMs ?? 4000;
  const inflight = new Map<string, Promise<{ spec: SpriteSpec; cached: boolean; source: "cache" | "model" | "offline" }>>();

  /** One designer call with the timeout; the offline designer answers on timeout, error or bad output. */
  async function runDesign(input: SpriteDesignInput, seed: number): Promise<{ spec: SpriteSpec; notes: string[]; source: "model" | "offline" }> {
    const fallback = () => designSpriteOffline(input, seed);
    const ac = new AbortController();
    let handle: unknown;
    const timeout = new Promise<"timeout">((resolve) => {
      handle = opts.timers.setTimeout(() => { ac.abort(); resolve("timeout"); }, timeoutMs);
    });
    const design = designSprite(
      opts.provider,
      { concept: input.concept, appearance: input.appearance, name: input.name, role: input.role, kind: input.kind },
      { finalize: (draft, ctx) => finalizeSpriteSpec(draft, { role: ctx.role, name: ctx.name }), fallback },
      { signal: ac.signal },
    );
    const r = await Promise.race([design, timeout]);
    opts.timers.clearTimeout(handle);
    if (r === "timeout") {
      opts.logger.warn("[sprite] designer timed out; used the offline designer");
      return { spec: fallback(), notes: ["the sprite designer timed out; used the offline designer"], source: "offline" };
    }
    return r;
  }

  async function make(input: SpriteDesignInput, key: string) {
    const cached = await opts.store.use("sprite", key);
    if (cached && cached.kind === "sprite") return { spec: cached.spec, cached: true, source: "cache" as const };

    const r = await runDesign(input, seedOf(key));
    if (r.source === "offline") return { spec: r.spec, cached: false, source: "offline" as const };
    const record: AssetRecord = {
      id: assetIdFromKey(key), key, kind: "sprite", created_at: new Date(opts.clock()).toISOString(), uses: 1, spec: r.spec,
    };
    await opts.store.put(record).catch((err: unknown) => opts.logger.warn("[sprite] could not store asset:", err instanceof Error ? err.message : String(err)));
    return { spec: r.spec, cached: false, source: "model" as const };
  }

  return {
    getOrCreateSprite(input) {
      const key = assetKey("sprite", input.concept, input.appearance ?? "");
      let p = inflight.get(key);
      if (!p) {
        p = make(input, key).finally(() => inflight.delete(key));
        inflight.set(key, p);
      }
      return p;
    },
    designFresh: (input, seed) => runDesign(input, seed),
    listAssets: (kind) => opts.store.list(kind),
  };
}
