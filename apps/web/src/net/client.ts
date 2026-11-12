import {
  ClientMessageSchema, ServerMessageSchema, WS_VERSION, exceedsMaxBytes, type ClientMessage, type ServerMessage,
} from "@aedm/schemas";
import {
  clearAuth, clearSessionToken, loadAuth, loadSessionToken, saveAuth, saveSessionToken,
} from "../state/storage";
import { createAuthState, resetRoom, type Store } from "../state/store";
import { AckTracker, backoffDelay, createIdGenerator, makeEnvelope } from "./envelope";
import type { Transport, TransportFactory } from "./transport";

export type ClientType = ClientMessage["type"];
export type ClientPayload<T extends ClientType> = Extract<ClientMessage, { type: T }>["payload"];

type Entry = { kind: "create" } | { kind: "join"; code: string } | { kind: "resume"; save_id: string; room_id: string };

export interface ClientHooks {
  /** Show a user-visible error (toast). */
  notify(message: string, kind?: "error" | "info"): void;
}

const PING_MS = 25_000;

export class GameClient {
  private transport: Transport | null = null;
  private attempt = 0;
  private closing = false;
  private resyncAsked = false;
  private entry: Entry | null = null;
  /** Bumped on every open and teardown so a stale transport's callbacks are ignored. */
  private gen = 0;
  /** Keep a connection open on the home screen (for account actions) and reconnect it when it drops. */
  private keepAlive = false;
  /** Runs once the resume_session reply (or a timeout) arrives; holds back create/join so the account is bound first. */
  private afterAuth: (() => void) | null = null;
  private authTimer: ReturnType<typeof setTimeout> | undefined;
  private resumeAck: string | null = null;
  /** Ack id of the last create_room, resume_campaign or join_room, so only its failure kicks us back to the home screen. */
  private entryAck: string | null = null;
  private wantCampaigns = false;
  private readonly replyWaiters = new Map<string, (type: string, msg: ServerMessage) => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private readonly acks = new AckTracker();
  private readonly nextId = createIdGenerator(Math.random().toString(36).slice(2, 8));

  constructor(
    private readonly store: Store,
    private readonly factory: TransportFactory,
    private readonly hooks: ClientHooks,
  ) {}

  // ---------- public API ----------

  /** Open the connection without a room (home screen): needed for log in, register and the account lists. */
  connect(): void {
    this.keepAlive = true;
    if (this.transport) return;
    this.open();
  }

  register(username: string, password: string, displayName: string): string | null {
    this.store.update((s) => { s.auth.pending = true; s.auth.error = null; });
    const id = this.send("register", { username, password, display_name: displayName });
    if (!id) this.store.update((s) => { s.auth.pending = false; });
    return id;
  }

  login(username: string, password: string): string | null {
    this.store.update((s) => { s.auth.pending = true; s.auth.error = null; });
    const id = this.send("login", { username, password });
    if (!id) this.store.update((s) => { s.auth.pending = false; });
    return id;
  }

  logout(): void {
    clearSessionToken();
    if (this.transport && this.store.state.conn === "open") this.send("logout", {});
    else this.store.update((s) => { s.auth = createAuthState(); });
  }

  refreshCampaigns(): void {
    if (!this.store.state.auth.user) return;
    if (this.afterAuth) this.wantCampaigns = true; // the connection is not logged in yet: ask once it is
    else this.send("list_campaigns", {});
  }

  /** Ask for the account's Workshop (a no-op for guests). The reply fills `auth.workshop`. */
  refreshWorkshop(): void {
    if (!this.store.state.auth.user) return;
    this.send("list_sprite_assets", {});
  }

  /** Open a lobby for a saved campaign; the host presses Load there. */
  resumeCampaign(c: { save_id: string; room_id: string }, displayName: string): void {
    this.entry = { kind: "resume", save_id: c.save_id, room_id: c.room_id };
    this.store.update((s) => { resetRoom(s); s.displayName = displayName; s.busy = true; });
    this.runEntry();
  }

  host(displayName: string): void {
    this.begin({ kind: "create" }, displayName);
  }

  join(code: string, displayName: string): void {
    this.begin({ kind: "join", code: code.trim().toUpperCase() }, displayName);
  }

  /** Leave the room and return to the home screen. */
  leave(): void {
    this.teardown();
    this.store.update((s) => { resetRoom(s); s.conn = "idle"; });
    if (this.keepAlive) this.open(); // back to the home screen with an account connection
  }

  /** Validate and send a client message. Returns its id, or null if it was not sent. */
  send<T extends ClientType>(type: T, payload: ClientPayload<T>): string | null {
    const id = this.nextId();
    const env = makeEnvelope(type, payload, id, Date.now());
    const parsed = ClientMessageSchema.safeParse(env);
    if (!parsed.success) {
      console.error("[net] refusing to send invalid", type, parsed.error.issues);
      this.hooks.notify("That action could not be sent (invalid message).");
      return null;
    }
    const raw = JSON.stringify(parsed.data);
    if (exceedsMaxBytes(raw)) {
      this.hooks.notify("That message is too long to send.");
      return null;
    }
    if (!this.transport || this.store.state.conn !== "open") {
      this.hooks.notify("Not connected. Trying to reconnect...");
      return null;
    }
    this.acks.track(id, type, Date.now());
    this.transport.send(raw);
    return id;
  }

  /** Run `fn` once, with the type of the server's reply to message `id` (its ack). */
  afterReply(id: string, fn: (replyType: string, msg: ServerMessage) => void): void {
    this.replyWaiters.set(id, fn);
  }

  get pendingAcks(): number {
    return this.acks.size;
  }

  // ---------- connection lifecycle ----------

  private begin(entry: Entry, displayName: string): void {
    const reuse = !!this.transport && this.store.state.conn === "open" && !this.store.state.playerId;
    if (!reuse) this.teardown();
    this.entry = entry;
    this.store.update((s) => {
      resetRoom(s);
      s.displayName = displayName;
      s.busy = true;
      if (entry.kind === "join") s.inviteCode = entry.code;
    });
    if (!reuse) this.open();
    else if (!this.afterAuth) this.runEntry(); // the open connection already carries the login
  }

  private open(): void {
    this.closing = false;
    const gen = ++this.gen;
    this.store.update((s) => { s.conn = this.attempt > 0 ? "reconnecting" : "connecting"; });
    this.transport = this.factory({
      onOpen: () => { if (gen === this.gen) this.handleOpen(); },
      onMessage: (raw) => { if (gen === this.gen) this.handleMessage(raw); },
      onClose: () => { if (gen === this.gen) this.handleClose(); },
    });
  }

  private teardown(): void {
    this.closing = true;
    this.gen++;
    clearTimeout(this.authTimer);
    this.afterAuth = null;
    this.replyWaiters.clear();
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    this.transport?.close();
    this.transport = null;
    this.entry = null;
    this.attempt = 0;
    this.acks.clear();
  }

  private handleOpen(): void {
    this.attempt = 0;
    const token = loadSessionToken();
    if (token) this.afterAuth = () => this.runEntry(); // set before subscribers see "open", so they wait for the login
    this.store.update((s) => { s.conn = "open"; });
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      this.acks.expire(Date.now(), 60_000);
      this.send("ping", {});
    }, PING_MS);
    if (token) {
      // bind the account before anything else, so create/join/reconnect see it
      this.store.update((s) => { s.auth.pending = !s.auth.user; });
      clearTimeout(this.authTimer);
      this.authTimer = setTimeout(() => this.flushAfterAuth(), 4000);
      this.resumeAck = this.send("resume_session", { session_token: token });
      if (!this.resumeAck) this.flushAfterAuth();
    } else {
      this.runEntry();
    }
  }

  private flushAfterAuth(): void {
    clearTimeout(this.authTimer);
    const fn = this.afterAuth;
    this.afterAuth = null;
    fn?.();
    if (this.wantCampaigns) {
      this.wantCampaigns = false;
      if (this.store.state.auth.user) this.send("list_campaigns", {});
    }
  }

  private runEntry(): void {
    const s = this.store.state;
    const entry = this.entry;
    if (entry?.kind === "create") {
      this.entryAck = this.send("create_room", { display_name: s.displayName });
    } else if (entry?.kind === "resume") {
      this.entryAck = this.send("resume_campaign", { save_id: entry.save_id, room_id: entry.room_id });
    } else if (entry?.kind === "join") {
      this.sendJoin(entry.code);
      this.entry = null;
    } else if (s.inviteCode && s.playerId) {
      this.sendJoin(s.inviteCode); // reconnect with the stored token
    }
  }

  private sendJoin(code: string): void {
    const s = this.store.state;
    const token = s.authToken ?? loadAuth(code)?.auth_token;
    this.entryAck = this.send("join_room", {
      invite_code: code,
      display_name: s.displayName,
      ...(token ? { auth_token: token } : {}),
    });
  }

  private handleClose(): void {
    clearInterval(this.pingTimer);
    this.transport = null;
    if (this.closing) {
      this.store.update((s) => { s.conn = "closed"; });
      return;
    }
    const s = this.store.state;
    if (!s.playerId && !this.entry) {
      if (this.keepAlive) this.scheduleReconnect(); // an idle account connection came back down
      return;
    }
    if (!s.playerId) {
      // never got into a room: report instead of retrying forever
      this.entry = null;
      this.store.update((st) => { st.conn = "closed"; st.busy = false; });
      this.hooks.notify("Could not reach the game server.");
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.store.update((st) => { st.conn = "reconnecting"; });
    const delay = backoffDelay(this.attempt++, Math.random());
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  // ---------- incoming ----------

  private handleMessage(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      console.warn("[net] ignoring non-JSON frame");
      return;
    }
    if (this.isVersionMismatch(json)) {
      this.store.update((s) => { s.versionMismatch = true; });
      return;
    }
    const parsed = ServerMessageSchema.safeParse(json);
    if (!parsed.success) {
      console.warn("[net] ignoring invalid server message", (json as { type?: unknown })?.type, parsed.error.issues);
      return;
    }
    const msg = parsed.data;
    if (msg.ack_id) {
      this.acks.ack(msg.ack_id);
      const waiter = this.replyWaiters.get(msg.ack_id);
      if (waiter) { this.replyWaiters.delete(msg.ack_id); waiter(msg.type, msg); }
    }
    this.store.apply(msg, Date.now());

    switch (msg.type) {
      case "auth_ok":
        if (msg.payload.session_token) saveSessionToken(msg.payload.session_token);
        this.flushAfterAuth();
        break;
      case "auth_error":
        if (msg.ack_id && msg.ack_id === this.resumeAck) {
          // a stale stored session is not an error worth showing
          if (msg.payload.code === "invalid_credentials") clearSessionToken();
          this.store.update((s) => { s.auth = createAuthState(); });
        }
        this.flushAfterAuth();
        break;
      case "logged_out":
        clearSessionToken();
        break;
      case "save_created":
        this.hooks.notify(`Saved "${msg.payload.name}"`, "info");
        break;
      case "room_created":
        // The creator then joins its own room like any other player.
        this.entry = null;
        this.sendJoin(msg.payload.invite_code);
        break;
      case "joined": {
        const code = this.store.state.inviteCode;
        if (code) saveAuth(code, { auth_token: msg.payload.auth_token, player_id: msg.payload.player_id });
        break;
      }
      case "error":
        this.hooks.notify(msg.payload.message, "error");
        if (!this.store.state.playerId && this.entryAck !== null && msg.ack_id === this.entryAck
          && ["not_found", "forbidden", "bad_message", "invalid_state"].includes(msg.payload.code)) {
          // a failed join: stay on the home screen
          const code = this.store.state.inviteCode;
          if (code && msg.payload.code === "forbidden") clearAuth(code);
          this.teardown();
          this.store.update((s) => { resetRoom(s); s.conn = "idle"; });
          if (this.keepAlive) this.open();
        }
        break;
      case "state_diff":
        if (this.store.state.needsResync && !this.resyncAsked && this.store.state.inviteCode) {
          this.resyncAsked = true; // a re-join makes the server send a fresh snapshot
          this.sendJoin(this.store.state.inviteCode);
        }
        break;
      case "state_snapshot":
        this.resyncAsked = false;
        break;
      default:
        break;
    }
  }

  private isVersionMismatch(json: unknown): boolean {
    if (typeof json !== "object" || json === null) return false;
    const o = json as { v?: unknown; type?: unknown; payload?: { code?: unknown } };
    if (o.type === "error" && o.payload?.code === "version_mismatch") return true;
    return typeof o.v === "number" && o.v !== WS_VERSION;
  }
}
