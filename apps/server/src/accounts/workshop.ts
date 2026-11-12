import { randomBytes } from "node:crypto";
import { FsKv, type KvBackend } from "../kv";
import { validatePixelSprite } from "@aedm/engine";
import {
  WORKSHOP_MAX_ASSETS, WORKSHOP_MAX_BYTES, WorkshopAssetRecordSchema, type WorkshopAsset, type WorkshopAssetRecord,
} from "@aedm/schemas";

export interface WorkshopInput {
  name: string;
  role_hint: WorkshopAssetRecord["role_hint"];
  concept: string;
  tags: string[];
  recipe: WorkshopAssetRecord["recipe"];
  source: WorkshopAssetRecord["source"];
}

export type WorkshopResult<T> = { ok: true; value: T } | { ok: false; code: "invalid" | "invalid_sprite" | "not_found" | "limit"; message: string };

export interface WorkshopUsage { used_bytes: number; max_assets: number; max_bytes: number }

/** Per-account sprite library. A database can implement this later. */
export interface WorkshopStore {
  /** The account's assets, newest first, without the owner id. */
  list(userId: string): Promise<{ assets: WorkshopAsset[] } & WorkshopUsage>;
  get(userId: string, id: string): Promise<WorkshopAssetRecord | null>;
  /** Creates (no `id`) or updates the account's own asset. Enforces the limits and validates pixel recipes. */
  save(userId: string, input: WorkshopInput, id?: string): Promise<WorkshopResult<WorkshopAssetRecord>>;
  delete(userId: string, id: string): Promise<boolean>;
}

export interface WorkshopLimits { maxAssets: number; maxBytes: number }

const sizeOf = (r: WorkshopAssetRecord): number => Buffer.byteLength(JSON.stringify(r), "utf8");
export const toWire = (r: WorkshopAssetRecord): WorkshopAsset => {
  const { owner_user_id: _o, ...rest } = r;
  return rest;
};

interface WorkshopFile { v: 1; assets: WorkshopAssetRecord[] }

export interface JsonWorkshopStoreOptions {
  /** Folder for one `<userId>.json` per account (created on first write, mode 0700). Ignored when `kv` is given. */
  dir?: string;
  /** Where the per-account `<userId>.json` values live. Defaults to files in `dir`. */
  kv?: KvBackend;
  clock?: () => number;
  limits?: Partial<WorkshopLimits>;
}

/** One JSON file per account, kept in memory once read, written atomically through a queue. */
export class JsonWorkshopStore implements WorkshopStore {
  private readonly clock: () => number;
  private readonly limits: WorkshopLimits;
  private readonly cache = new Map<string, Promise<WorkshopAssetRecord[]>>();
  private queue: Promise<void> = Promise.resolve();

  private readonly kv: KvBackend;

  constructor(opts: JsonWorkshopStoreOptions) {
    if (!opts.kv && !opts.dir) throw new Error("JsonWorkshopStore needs a dir or a kv");
    this.kv = opts.kv ?? new FsKv(opts.dir as string);
    this.clock = opts.clock ?? Date.now;
    this.limits = { maxAssets: opts.limits?.maxAssets ?? WORKSHOP_MAX_ASSETS, maxBytes: opts.limits?.maxBytes ?? WORKSHOP_MAX_BYTES };
  }

  private fileFor(userId: string): string | null {
    return /^[A-Za-z0-9_-]{1,64}$/.test(userId) ? `${userId}.json` : null;
  }

  private load(userId: string): Promise<WorkshopAssetRecord[]> {
    let p = this.cache.get(userId);
    if (!p) {
      p = (async () => {
        const file = this.fileFor(userId);
        if (!file) return [];
        {
          const text = await this.kv.get(file);
          if (text === null) return [];
          const data = JSON.parse(text) as Partial<WorkshopFile>;
          const out: WorkshopAssetRecord[] = [];
          for (const a of data.assets ?? []) {
            const r = WorkshopAssetRecordSchema.safeParse(a);
            if (r.success && r.data.owner_user_id === userId) out.push(r.data);
          }
          return out;
        }
      })();
      this.cache.set(userId, p);
    }
    return p;
  }

  private persist(userId: string, assets: WorkshopAssetRecord[]): Promise<void> {
    const file = this.fileFor(userId);
    if (!file) return Promise.resolve();
    const snapshot = JSON.stringify({ v: 1, assets } satisfies WorkshopFile);
    const job = this.queue.then(async () => {
      await this.kv.put(file, snapshot);
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  private usage(assets: WorkshopAssetRecord[]): WorkshopUsage {
    return { used_bytes: assets.reduce((n, a) => n + sizeOf(a), 0), max_assets: this.limits.maxAssets, max_bytes: this.limits.maxBytes };
  }

  async list(userId: string) {
    const assets = await this.load(userId);
    const sorted = [...assets].sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
    return { assets: sorted.map(toWire), ...this.usage(assets) };
  }

  async get(userId: string, id: string): Promise<WorkshopAssetRecord | null> {
    return (await this.load(userId)).find((a) => a.id === id) ?? null;
  }

  async save(userId: string, input: WorkshopInput, id?: string): Promise<WorkshopResult<WorkshopAssetRecord>> {
    if (!this.fileFor(userId)) return { ok: false, code: "invalid", message: "No such account." };
    if (input.recipe.kind === "pixel") {
      const px = validatePixelSprite(input.recipe);
      if (!px.ok) return { ok: false, code: "invalid_sprite", message: `That painted sprite was refused: ${px.errors.map((e) => e.message).join(" ")}` };
    }
    const assets = await this.load(userId);
    const existing = id ? assets.find((a) => a.id === id) : undefined;
    if (id && !existing) return { ok: false, code: "not_found", message: "No such Workshop sprite." };
    if (!existing && assets.length >= this.limits.maxAssets) {
      return { ok: false, code: "limit", message: `Your Workshop holds ${this.limits.maxAssets} sprites. Delete one first.` };
    }
    const now = new Date(this.clock()).toISOString();
    const candidate = WorkshopAssetRecordSchema.safeParse({
      id: existing?.id ?? `as_w${randomBytes(9).toString("base64url")}`,
      owner_user_id: userId,
      name: input.name, role_hint: input.role_hint, concept: input.concept, tags: input.tags, recipe: input.recipe, source: input.source,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    });
    if (!candidate.success) return { ok: false, code: "invalid", message: "That sprite is not valid." };
    const rec = candidate.data;
    const others = assets.filter((a) => a !== existing);
    if (this.usage(others).used_bytes + sizeOf(rec) > this.limits.maxBytes) {
      return { ok: false, code: "limit", message: "Your Workshop is full (5 MB). Delete something first." };
    }
    // no await between the checks above and the mutation below, so concurrent saves cannot overshoot the limits
    if (existing) assets[assets.indexOf(existing)] = rec;
    else assets.push(rec);
    await this.persist(userId, assets);
    return { ok: true, value: rec };
  }

  async delete(userId: string, id: string): Promise<boolean> {
    const assets = await this.load(userId);
    const i = assets.findIndex((a) => a.id === id);
    if (i < 0) return false;
    assets.splice(i, 1);
    await this.persist(userId, assets);
    return true;
  }

  /** For tests: the usage numbers of an account. */
  async usageOf(userId: string): Promise<WorkshopUsage> {
    return this.usage(await this.load(userId));
  }
}
