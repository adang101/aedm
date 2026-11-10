import { CharacterCreateSchema, RoomSettingsSchema, validateRegistration, type Ability, type CharacterCreate, type ClientMessage } from "@aedm/schemas";
import type { Conn } from "../net";
import { DEFAULT_SETTINGS, type Room, type RoomRegistry } from "../rooms";
import { listOwnedSaves, readSaveExact } from "../saves";
import type { Deps } from "../types";
import { normalizeUsername, summarize, toAuthUser, type CharacterTemplate, type UserRecord } from "./store";

type Msg<T extends ClientMessage["type"]> = Extract<ClientMessage, { type: T }>;

const ACCOUNT_TYPES = new Set<ClientMessage["type"]>([
  "register", "login", "resume_session", "logout", "list_characters", "save_character_template",
  "delete_character_template", "list_campaigns", "resume_campaign",
]);

/** Attempts per connection and window. Failed logins per username use the same numbers. */
const AUTH_MAX = 5;
const AUTH_WINDOW_MS = 60_000;
const MAX_TRACKED_NAMES = 5000;

/** Everything about accounts that works before (or without) joining a room. */
export class AccountHandlers {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly deps: Deps,
    private readonly registry: RoomRegistry,
    private readonly hooks: { onRoomCreated(room: Room): void },
  ) {}

  private get store() { return this.deps.accounts; }

  handles(type: ClientMessage["type"]): boolean {
    return ACCOUNT_TYPES.has(type);
  }

  async dispatch(conn: Conn, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case "register": return this.register(conn, msg as Msg<"register">);
      case "login": return this.login(conn, msg as Msg<"login">);
      case "resume_session": return this.resume(conn, msg as Msg<"resume_session">);
      case "logout": return this.logout(conn, msg.id);
      default: break;
    }
    const user = conn.userId ? await this.store.getUser(conn.userId) : null;
    if (!user) return conn.error("forbidden", "Log in to do that.", msg.id);
    switch (msg.type) {
      case "list_characters": return conn.send("characters_list", { characters: user.characters.map(summarize) }, msg.id);
      case "save_character_template": return this.saveTemplate(conn, user, msg as Msg<"save_character_template">);
      case "delete_character_template": return this.deleteTemplate(conn, user, msg as Msg<"delete_character_template">);
      case "list_campaigns": {
        const campaigns = await listOwnedSaves(this.deps.saveDir, user.id);
        return conn.send("campaigns_list", { campaigns }, msg.id);
      }
      case "resume_campaign": return this.resumeCampaign(conn, user, msg as Msg<"resume_campaign">);
      default: return;
    }
  }

  // ---------- hooks used by the room handlers ----------

  /** Marks the connection (and its seat, if it already sits in a room) as belonging to the account. */
  private bind(conn: Conn, user: UserRecord): void {
    conn.userId = user.id;
    const room = conn.roomId ? this.registry.get(conn.roomId) : undefined;
    const player = room?.player(conn.playerId);
    if (player) player.userId = user.id;
  }

  /** A saved character for claim_character. Null when absent or not this account's. */
  async loadTemplate(conn: Conn, templateId: string): Promise<CharacterTemplate | null> {
    const user = conn.userId ? await this.store.getUser(conn.userId) : null;
    const tpl = user?.characters.find((c) => c.id === templateId);
    if (!tpl) return null;
    return CharacterCreateSchema.safeParse(tpl.character).success ? tpl : null;
  }

  /** Remembers the forge result so "Save to my characters" can keep it; refreshes a template that was just used. */
  async afterForge(conn: Conn, create: CharacterCreate, abilities: Ability[], templateId?: string): Promise<void> {
    if (!conn.userId) return;
    conn.lastForged = { name: create.name.toLowerCase(), abilities };
    if (templateId) await this.store.setForged(conn.userId, templateId, abilities);
  }

  // ---------- auth ----------

  private allowAttempt(conn: Conn): boolean {
    return conn.limiter.allow("auth", this.deps.clock(), AUTH_MAX, AUTH_WINDOW_MS);
  }

  private recentFailures(key: string): number[] {
    const now = this.deps.clock();
    const arr = (this.failures.get(key) ?? []).filter((t) => now - t < AUTH_WINDOW_MS);
    if (arr.length) this.failures.set(key, arr);
    else this.failures.delete(key);
    return arr;
  }

  private noteFailure(key: string): void {
    const arr = this.recentFailures(key);
    arr.push(this.deps.clock());
    if (this.failures.size >= MAX_TRACKED_NAMES) {
      for (const k of [...this.failures.keys()]) this.recentFailures(k);
      if (this.failures.size >= MAX_TRACKED_NAMES) this.failures.clear();
    }
    this.failures.set(key, arr);
  }

  private async authOk(conn: Conn, user: UserRecord, ack: string, token?: string): Promise<void> {
    this.bind(conn, user);
    conn.send("auth_ok", {
      user: toAuthUser(user),
      ...(token ? { session_token: token } : {}),
      characters: user.characters.map(summarize),
    }, ack);
  }

  private blockedBySeat(conn: Conn, userId: string | null): boolean {
    return !!conn.roomId && !!conn.userId && conn.userId !== userId;
  }

  private async register(conn: Conn, msg: Msg<"register">): Promise<void> {
    const ack = msg.id;
    if (!this.allowAttempt(conn)) return conn.send("auth_error", { code: "rate_limited", message: "Too many attempts. Wait a minute and try again." }, ack);
    const p = msg.payload;
    const problem = validateRegistration(p);
    if (problem) return conn.send("auth_error", { code: "invalid", message: problem }, ack);
    if (conn.roomId && conn.userId) return conn.send("auth_error", { code: "invalid", message: "Log out before creating another account." }, ack);
    const r = await this.store.register(p);
    if (!r.ok) {
      const code = r.code === "username_taken" ? "username_taken" : "invalid";
      return conn.send("auth_error", { code, message: r.message }, ack);
    }
    const session = await this.store.createSession(r.value.id);
    conn.sessionToken = session.token;
    await this.authOk(conn, r.value, ack, session.token);
  }

  private async login(conn: Conn, msg: Msg<"login">): Promise<void> {
    const ack = msg.id;
    const limited = () => conn.send("auth_error", { code: "rate_limited", message: "Too many attempts. Wait a minute and try again." }, ack);
    if (!this.allowAttempt(conn)) return limited();
    const key = normalizeUsername(msg.payload.username).slice(0, 64);
    if (this.recentFailures(key).length >= AUTH_MAX) return limited();
    const user = await this.store.verifyLogin(msg.payload.username, msg.payload.password);
    if (!user) {
      this.noteFailure(key);
      return conn.send("auth_error", { code: "invalid_credentials", message: "Wrong username or password." }, ack);
    }
    if (this.blockedBySeat(conn, user.id)) {
      return conn.send("auth_error", { code: "invalid", message: "Leave the room before switching accounts." }, ack);
    }
    const session = await this.store.createSession(user.id);
    conn.sessionToken = session.token;
    await this.authOk(conn, user, ack, session.token);
  }

  private async resume(conn: Conn, msg: Msg<"resume_session">): Promise<void> {
    const ack = msg.id;
    if (!conn.limiter.allow("resume", this.deps.clock(), 10, AUTH_WINDOW_MS)) {
      return conn.send("auth_error", { code: "rate_limited", message: "Too many attempts. Wait a minute and try again." }, ack);
    }
    const token = msg.payload.session_token;
    const user = await this.store.resumeSession(token);
    if (!user) return conn.send("auth_error", { code: "invalid_credentials", message: "Your session has expired. Please log in again." }, ack);
    if (this.blockedBySeat(conn, user.id)) {
      return conn.send("auth_error", { code: "invalid", message: "Leave the room before switching accounts." }, ack);
    }
    conn.sessionToken = token;
    await this.authOk(conn, user, ack);
  }

  private async logout(conn: Conn, ack: string): Promise<void> {
    if (conn.sessionToken) await this.store.deleteSession(conn.sessionToken);
    const room = conn.roomId ? this.registry.get(conn.roomId) : undefined;
    const player = room?.player(conn.playerId);
    if (player) player.userId = null;
    conn.userId = null;
    conn.sessionToken = null;
    conn.lastForged = null;
    conn.send("logged_out", {}, ack);
  }

  // ---------- characters and campaigns ----------

  private async saveTemplate(conn: Conn, user: UserRecord, msg: Msg<"save_character_template">): Promise<void> {
    const character = msg.payload.character;
    const forged = conn.lastForged && conn.lastForged.name === character.name.toLowerCase() ? conn.lastForged.abilities : undefined;
    const r = await this.store.saveCharacter(user.id, character, forged);
    if (!r.ok) return conn.error(r.code === "limit" ? "invalid_state" : "bad_message", r.message, msg.id);
    const fresh = await this.store.getUser(user.id);
    conn.send("characters_list", { characters: (fresh?.characters ?? []).map(summarize) }, msg.id);
  }

  private async deleteTemplate(conn: Conn, user: UserRecord, msg: Msg<"delete_character_template">): Promise<void> {
    if (!(await this.store.deleteCharacter(user.id, msg.payload.id))) return conn.error("not_found", "No such saved character.", msg.id);
    const fresh = await this.store.getUser(user.id);
    conn.send("characters_list", { characters: (fresh?.characters ?? []).map(summarize) }, msg.id);
  }

  /** Opens a lobby for a save the account owns. The host joins it like any room, then sends load_save. */
  private async resumeCampaign(conn: Conn, user: UserRecord, msg: Msg<"resume_campaign">): Promise<void> {
    if (conn.roomId) return conn.error("invalid_state", "You are already in a room.", msg.id);
    const { save_id, room_id } = msg.payload;
    const save = await readSaveExact(this.deps.saveDir, room_id, save_id);
    if (!save || save.owner_user_id !== user.id) return conn.error("not_found", "No such campaign.", msg.id);
    const room = this.registry.create(conn);
    room.ownerUserId = user.id;
    const settings = RoomSettingsSchema.safeParse(save.room.settings);
    room.settings = settings.success ? settings.data : { ...DEFAULT_SETTINGS };
    room.resume = { roomId: room_id, saveId: save_id, name: (save.name || save_id).slice(0, 30) };
    this.hooks.onRoomCreated(room);
    conn.send("room_created", { room_id: room.id, invite_code: room.code }, msg.id);
  }
}
