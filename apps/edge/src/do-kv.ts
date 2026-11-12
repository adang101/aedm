import type { KvBackend } from "@aedm/server/src/kv";
import { assertSafeKey } from "@aedm/server/src/kv";

/** One stored value is split into pieces this long, so a big value (a Workshop can hold 5 MB) stays under the per-value limit. */
export const CHUNK_CHARS = 400_000;

/** The slice of DurableObjectStorage this uses (so tests can pass a fake). */
export interface StorageLike {
  get<T>(keys: string[]): Promise<Map<string, T>>;
  get<T>(key: string): Promise<T | undefined>;
  put<T>(entries: Record<string, T>): Promise<void>;
  delete(keys: string[]): Promise<number>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}

const metaKey = (key: string): string => `m:${key}`;
const chunkKey = (key: string, i: number): string => `d:${key}:${i}`;

/**
 * KvBackend on Durable Object storage. Each value is a chunk count under `m:<key>` plus chunks under `d:<key>:<n>`.
 * A put is one atomic storage write, so a reader never sees half of a value.
 */
export class DoKv implements KvBackend {
  constructor(private readonly storage: StorageLike) {}

  async get(key: string): Promise<string | null> {
    assertSafeKey(key);
    const count = await this.storage.get<number>(metaKey(key));
    if (count === undefined) return null;
    if (count === 0) return "";
    const keys = Array.from({ length: count }, (_, i) => chunkKey(key, i));
    const got = await this.storage.get<string>(keys);
    return keys.map((k) => got.get(k) ?? "").join("");
  }

  async put(key: string, value: string): Promise<void> {
    assertSafeKey(key);
    const old = await this.storage.get<number>(metaKey(key));
    const count = Math.ceil(value.length / CHUNK_CHARS);
    const entries: Record<string, number | string> = { [metaKey(key)]: count };
    for (let i = 0; i < count; i++) entries[chunkKey(key, i)] = value.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS);
    if (Object.keys(entries).length > 128) throw new Error("value too large for one storage write");
    await this.storage.put(entries);
    if (old !== undefined && old > count) {
      await this.storage.delete(Array.from({ length: old - count }, (_, i) => chunkKey(key, count + i)));
    }
  }

  async list(prefix = ""): Promise<string[]> {
    const found = await this.storage.list<number>({ prefix: metaKey(prefix) });
    return [...found.keys()].map((k) => k.slice(2));
  }
}
