import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * The one storage primitive every store sits on: string values under "/"-separated keys.
 * Node uses files (FsKv), tests use memory (MemoryKv), Cloudflare uses Durable Object storage.
 * Keys must be relative, with no "." or ".." parts.
 */
export interface KvBackend {
  get(key: string): Promise<string | null>;
  /** Replaces the value. Implementations make this atomic (a reader sees the old or the new value, never half of one). */
  put(key: string, value: string): Promise<void>;
  /** Every key that starts with `prefix`, in no particular order. */
  list(prefix?: string): Promise<string[]>;
}

const SAFE_KEY = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;
export function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.split("/").some((p) => p === "." || p === "..")) throw new Error(`unsafe storage key: ${key}`);
}

export interface FsKvOptions {
  /** Mode for new files (default 0o600) and folders (default 0o700): accounts hold password hashes. */
  fileMode?: number;
  dirMode?: number;
}

/** Keys are paths under `dir`. Writes go to `<file>.tmp`, then rename. */
export class FsKv implements KvBackend {
  constructor(private readonly dir: string, private readonly opts: FsKvOptions = {}) {}

  async get(key: string): Promise<string | null> {
    assertSafeKey(key);
    try {
      return await readFile(join(this.dir, key), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async put(key: string, value: string): Promise<void> {
    assertSafeKey(key);
    const file = join(this.dir, key);
    await mkdir(dirname(file), { recursive: true, mode: this.opts.dirMode ?? 0o700 });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, value, { encoding: "utf8", mode: this.opts.fileMode ?? 0o600 });
    await rename(tmp, file);
  }

  async list(prefix = ""): Promise<string[]> {
    const out: string[] = [];
    const walk = async (rel: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(join(this.dir, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const key = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(key);
        else if (e.isFile() && !e.name.endsWith(".tmp") && key.startsWith(prefix)) out.push(key);
      }
    };
    await walk("");
    return out;
  }
}

export class MemoryKv implements KvBackend {
  private readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> { assertSafeKey(key); return this.map.get(key) ?? null; }
  async put(key: string, value: string): Promise<void> { assertSafeKey(key); this.map.set(key, value); }
  async list(prefix = ""): Promise<string[]> { return [...this.map.keys()].filter((k) => k.startsWith(prefix)); }
}
