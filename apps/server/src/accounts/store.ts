import { createHash, randomBytes } from "node:crypto";
import { FsKv, type KvBackend } from "../kv";
import {
  CharacterCreateSchema, MAX_SAVED_CHARACTERS, PASSWORD_MAX, PASSWORD_MIN, USERNAME_PATTERN,
  type Ability, type AuthUser, type CharacterCreate, type CharacterSummary,
} from "@aedm/schemas";
import { designSpriteOffline } from "@aedm/engine";
import { hashPassword, verifyDummy, verifyPassword } from "./password";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_SESSIONS_PER_USER = 10;
/** A resumed session is only re-written to disk when its expiry is at least this far behind a fresh one. */
const REFRESH_AFTER_MS = 60 * 60 * 1000;

/** A character the user can reuse across campaigns. */
export interface CharacterTemplate {
  id: string;
  saved_at: string;
  /** Exactly what the creator submitted. Claiming runs it through the normal forge path. */
  character: CharacterCreate;
  /** Abilities from the last forge run, kept for display. */
  forged_abilities?: Ability[];
}

export interface UserRecord {
  id: string;
  /** Lowercase. */
  username: string;
  /** `scrypt$N$r$p$saltB64$hashB64`. */
  password_hash: string;
  display_name: string;
  created_at: string;
  characters: CharacterTemplate[];
}

export interface SessionRecord {
  /** sha256 (hex) of the token. The token itself is never stored. */
  token_hash: string;
  user_id: string;
  created_at: number;
  expires_at: number;
}

export type StoreResult<T> = { ok: true; value: T } | { ok: false; code: "username_taken" | "invalid" | "not_found" | "limit"; message: string };

/** Everything the server needs from account storage. A database can implement this later. */
export interface AccountStore {
  register(input: { username: string; password: string; display_name: string }): Promise<StoreResult<UserRecord>>;
  /** Null for an unknown user and for a wrong password alike. */
  verifyLogin(username: string, password: string): Promise<UserRecord | null>;
  createSession(userId: string): Promise<{ token: string; expires_at: number }>;
  /** Slides the expiry forward. Null for unknown, expired or deleted sessions. */
  resumeSession(token: string): Promise<UserRecord | null>;
  deleteSession(token: string): Promise<void>;
  getUser(id: string): Promise<UserRecord | null>;
  saveCharacter(userId: string, character: CharacterCreate, forged?: Ability[]): Promise<StoreResult<CharacterTemplate>>;
  setForged(userId: string, templateId: string, forged: Ability[]): Promise<void>;
  deleteCharacter(userId: string, templateId: string): Promise<boolean>;
}

export const normalizeUsername = (u: string): string => u.trim().toLowerCase();
const hashToken = (t: string): string => createHash("sha256").update(t).digest("hex");

export function toAuthUser(u: UserRecord): AuthUser {
  return { id: u.id, username: u.username, display_name: u.display_name };
}

function abilityNames(t: CharacterTemplate): string[] {
  if (t.forged_abilities?.length) return t.forged_abilities.map((a) => a.name);
  const c = t.character;
  const raw = c.abilities ? c.abilities.map((a) => a.name) : (c.ability_texts ?? []).map((x) => {
    const head = x.split(":")[0] ?? x;
    return head.length < x.length && head.length <= 40 ? head : x.split(/\s+/).slice(0, 3).join(" ");
  });
  return raw.map((n) => n.trim().slice(0, 60)).filter(Boolean).slice(0, 3);
}

export function summarize(t: CharacterTemplate): CharacterSummary {
  const c = t.character;
  return {
    id: t.id, name: c.name, title: c.title, key_ability: c.key_ability,
    sprite_recipe: c.sprite_recipe ?? designSpriteOffline({ concept: `${c.title} ${c.description}`.trim() || c.name, name: c.name, role: "pc", kind: "pc" }, 1),
    ability_names: abilityNames(t), forged: !!t.forged_abilities?.length, saved_at: t.saved_at,
  };
}

interface UsersFile { v: 1; users: UserRecord[] }
interface SessionsFile { v: 1; sessions: SessionRecord[] }

export interface JsonAccountStoreOptions {
  /** Folder for users.json and sessions.json (created on first write, mode 0700). Ignored when `kv` is given. */
  dir?: string;
  /** Where users.json and sessions.json live. Defaults to files in `dir`. */
  kv?: KvBackend;
  clock?: () => number;
}

/** Accounts as two JSON files. Reads once, keeps everything in memory, writes atomically through a queue. */
export class JsonAccountStore implements AccountStore {
  private readonly clock: () => number;
  private loaded: Promise<void> | null = null;
  private readonly byId = new Map<string, UserRecord>();
  private readonly byName = new Map<string, UserRecord>();
  private sessions: SessionRecord[] = [];
  private queue: Promise<void> = Promise.resolve();
  private readonly kv: KvBackend;

  constructor(opts: JsonAccountStoreOptions) {
    this.clock = opts.clock ?? Date.now;
    if (!opts.kv && !opts.dir) throw new Error("JsonAccountStore needs a dir or a kv");
    this.kv = opts.kv ?? new FsKv(opts.dir as string);
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      const users = await readJson<UsersFile>(this.kv, "users.json");
      for (const u of users?.users ?? []) this.index(u);
      const sess = await readJson<SessionsFile>(this.kv, "sessions.json");
      const now = this.clock();
      this.sessions = (sess?.sessions ?? []).filter((s) => s.expires_at > now && this.byId.has(s.user_id));
    })();
    return this.loaded;
  }

  private index(u: UserRecord): void {
    this.byId.set(u.id, u);
    this.byName.set(u.username, u);
  }

  /** Atomic write (temp file, then rename). Writes run one at a time and serialize the state as of their turn. */
  private persist(which: "users" | "sessions"): Promise<void> {
    const job = this.queue.then(async () => {
      const key = which === "users" ? "users.json" : "sessions.json";
      const data = which === "users"
        ? ({ v: 1, users: [...this.byId.values()] } satisfies UsersFile)
        : ({ v: 1, sessions: this.sessions } satisfies SessionsFile);
      await this.kv.put(key, JSON.stringify(data));
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  async register(input: { username: string; password: string; display_name: string }): Promise<StoreResult<UserRecord>> {
    await this.load();
    const username = normalizeUsername(input.username);
    const display = input.display_name.trim();
    if (!USERNAME_PATTERN.test(username)) return { ok: false, code: "invalid", message: "Usernames are 3 to 20 characters: letters, digits, _ or -." };
    if (input.password.length < PASSWORD_MIN || input.password.length > PASSWORD_MAX) {
      return { ok: false, code: "invalid", message: `Passwords are ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.` };
    }
    const len = [...display].length;
    if (len < 1 || len > 24) return { ok: false, code: "invalid", message: "Display names are 1 to 24 characters." };
    if (this.byName.has(username)) return { ok: false, code: "username_taken", message: "That username is taken." };
    const password_hash = await hashPassword(input.password);
    // re-check after the async hash: no await between this check and the insert
    if (this.byName.has(username)) return { ok: false, code: "username_taken", message: "That username is taken." };
    const user: UserRecord = {
      id: `u_${randomBytes(9).toString("base64url")}`,
      username, password_hash, display_name: display,
      created_at: new Date(this.clock()).toISOString(), characters: [],
    };
    this.index(user);
    await this.persist("users");
    return { ok: true, value: user };
  }

  async verifyLogin(username: string, password: string): Promise<UserRecord | null> {
    await this.load();
    const user = this.byName.get(normalizeUsername(username));
    if (!user) { await verifyDummy(password); return null; }
    return (await verifyPassword(password, user.password_hash)) ? user : null;
  }

  async createSession(userId: string): Promise<{ token: string; expires_at: number }> {
    await this.load();
    const now = this.clock();
    const token = randomBytes(32).toString("base64url");
    const rec: SessionRecord = { token_hash: hashToken(token), user_id: userId, created_at: now, expires_at: now + SESSION_TTL_MS };
    this.sessions = this.sessions.filter((s) => s.expires_at > now);
    this.sessions.push(rec);
    const mine = this.sessions.filter((s) => s.user_id === userId).sort((a, b) => a.created_at - b.created_at);
    const drop = new Set(mine.slice(0, Math.max(0, mine.length - MAX_SESSIONS_PER_USER)));
    if (drop.size) this.sessions = this.sessions.filter((s) => !drop.has(s));
    await this.persist("sessions");
    return { token, expires_at: rec.expires_at };
  }

  async resumeSession(token: string): Promise<UserRecord | null> {
    await this.load();
    const hash = hashToken(token);
    const now = this.clock();
    const s = this.sessions.find((x) => x.token_hash === hash);
    if (!s) return null;
    if (s.expires_at <= now) {
      this.sessions = this.sessions.filter((x) => x !== s);
      await this.persist("sessions");
      return null;
    }
    const user = this.byId.get(s.user_id) ?? null;
    if (user && now + SESSION_TTL_MS - s.expires_at >= REFRESH_AFTER_MS) {
      s.expires_at = now + SESSION_TTL_MS;
      await this.persist("sessions");
    }
    return user;
  }

  async deleteSession(token: string): Promise<void> {
    await this.load();
    const hash = hashToken(token);
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((s) => s.token_hash !== hash);
    if (this.sessions.length !== before) await this.persist("sessions");
  }

  async getUser(id: string): Promise<UserRecord | null> {
    await this.load();
    return this.byId.get(id) ?? null;
  }

  async saveCharacter(userId: string, character: CharacterCreate, forged?: Ability[]): Promise<StoreResult<CharacterTemplate>> {
    await this.load();
    const user = this.byId.get(userId);
    if (!user) return { ok: false, code: "not_found", message: "No such account." };
    const parsed = CharacterCreateSchema.safeParse(character);
    if (!parsed.success) return { ok: false, code: "invalid", message: "That character is not valid." };
    const name = parsed.data.name.toLowerCase();
    const existing = user.characters.find((c) => c.character.name.toLowerCase() === name);
    if (!existing && user.characters.length >= MAX_SAVED_CHARACTERS) {
      return { ok: false, code: "limit", message: `You can keep ${MAX_SAVED_CHARACTERS} saved characters. Delete one first.` };
    }
    const tpl: CharacterTemplate = {
      id: existing?.id ?? `ch_${randomBytes(9).toString("base64url")}`,
      saved_at: new Date(this.clock()).toISOString(),
      character: parsed.data,
      ...(forged?.length ? { forged_abilities: forged } : {}),
    };
    if (existing) user.characters[user.characters.indexOf(existing)] = tpl;
    else user.characters.push(tpl);
    await this.persist("users");
    return { ok: true, value: tpl };
  }

  async setForged(userId: string, templateId: string, forged: Ability[]): Promise<void> {
    await this.load();
    const tpl = this.byId.get(userId)?.characters.find((c) => c.id === templateId);
    if (!tpl) return;
    tpl.forged_abilities = forged.slice(0, 3);
    await this.persist("users");
  }

  async deleteCharacter(userId: string, templateId: string): Promise<boolean> {
    await this.load();
    const user = this.byId.get(userId);
    const i = user?.characters.findIndex((c) => c.id === templateId) ?? -1;
    if (!user || i < 0) return false;
    user.characters.splice(i, 1);
    await this.persist("users");
    return true;
  }
}

async function readJson<T>(kv: KvBackend, key: string): Promise<T | null> {
  const raw = await kv.get(key);
  return raw === null ? null : (JSON.parse(raw) as T);
}
