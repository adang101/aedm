import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AssetRecordSchema, type AssetKind, type AssetRecord } from "@aedm/schemas";

/** Lowercase and collapse whitespace so trivially different spellings of a concept share an asset. */
export function normalizeConcept(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Store key: sha256(kind + normalized concept + normalized appearance), hex. */
export function assetKey(kind: AssetKind, concept: string, appearance = ""): string {
  return createHash("sha256").update(`${kind}\n${normalizeConcept(concept)}\n${normalizeConcept(appearance)}`).digest("hex");
}

export const assetIdFromKey = (key: string): string => `as_${key.slice(0, 24)}`;

/** Everything the server needs from asset storage. A database can implement this later. */
export interface AssetStore {
  /** The cached record, with `uses` incremented; null when there is none. */
  use(kind: AssetKind, key: string): Promise<AssetRecord | null>;
  /** Adds a record (replacing one with the same kind and key). */
  put(record: AssetRecord): Promise<void>;
  list(kind?: AssetKind): Promise<AssetRecord[]>;
}

interface AssetsFile { v: 1; assets: AssetRecord[] }

export interface JsonAssetStoreOptions {
  /** Folder that holds assets.json (created on first write). */
  dir: string;
}

/** Assets as one JSON file. Reads once, keeps everything in memory, writes atomically through a queue. */
export class JsonAssetStore implements AssetStore {
  private loaded: Promise<void> | null = null;
  private readonly records = new Map<string, AssetRecord>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly opts: JsonAssetStoreOptions) {}

  private get file(): string { return join(this.opts.dir, "assets.json"); }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      let raw: AssetsFile | null = null;
      try {
        raw = JSON.parse(await readFile(this.file, "utf8")) as AssetsFile;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          // A corrupt file must not stop the game: start empty, the next write replaces it.
          if (!(err instanceof SyntaxError)) throw err;
        }
      }
      for (const r of raw?.assets ?? []) {
        const p = AssetRecordSchema.safeParse(r);
        if (p.success) this.records.set(`${p.data.kind}:${p.data.key}`, p.data);
      }
    })();
    return this.loaded;
  }

  /** Atomic write (temp file, then rename). Writes run one at a time and serialize the state as of their turn. */
  private persist(): Promise<void> {
    const job = this.queue.then(async () => {
      await mkdir(this.opts.dir, { recursive: true });
      const data: AssetsFile = { v: 1, assets: [...this.records.values()] };
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(data), "utf8");
      await rename(tmp, this.file);
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  /** Resolves when every queued write has finished. */
  async flush(): Promise<void> {
    await this.queue;
  }

  async use(kind: AssetKind, key: string): Promise<AssetRecord | null> {
    await this.load();
    const r = this.records.get(`${kind}:${key}`);
    if (!r) return null;
    const next = { ...r, uses: r.uses + 1 } as AssetRecord;
    this.records.set(`${kind}:${key}`, next);
    void this.persist().catch(() => undefined);
    return next;
  }

  async put(record: AssetRecord): Promise<void> {
    await this.load();
    this.records.set(`${record.kind}:${record.key}`, record);
    await this.persist();
  }

  async list(kind?: AssetKind): Promise<AssetRecord[]> {
    await this.load();
    return [...this.records.values()].filter((r) => kind === undefined || r.kind === kind);
  }
}

/** In-memory store for tests that do not need files. */
export class MemoryAssetStore implements AssetStore {
  private readonly records = new Map<string, AssetRecord>();
  async use(kind: AssetKind, key: string): Promise<AssetRecord | null> {
    const r = this.records.get(`${kind}:${key}`);
    if (!r) return null;
    const next = { ...r, uses: r.uses + 1 } as AssetRecord;
    this.records.set(`${kind}:${key}`, next);
    return next;
  }
  async put(record: AssetRecord): Promise<void> { this.records.set(`${record.kind}:${record.key}`, record); }
  async list(kind?: AssetKind): Promise<AssetRecord[]> { return [...this.records.values()].filter((r) => kind === undefined || r.kind === kind); }
}
