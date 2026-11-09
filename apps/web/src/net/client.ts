import {
  ClientMessageSchema, ServerMessageSchema, WS_VERSION, exceedsMaxBytes, type ClientMessage,
} from "@aedm/schemas";
import { clearAuth, loadAuth, saveAuth } from "../state/storage";
import { resetRoom, type Store } from "../state/store";
import { AckTracker, backoffDelay, createIdGenerator, makeEnvelope } from "./envelope";
import type { Transport, TransportFactory } from "./transport";

export type ClientType = ClientMessage["type"];
export type ClientPayload<T extends ClientType> = Extract<ClientMessage, { type: T }>["payload"];

type Entry = { kind: "create" } | { kind: "join"; code: string };

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

  get pendingAcks(): number {
    return this.acks.size;
  }

  // ---------- connection lifecycle ----------

  private begin(entry: Entry, displayName: string): void {
    this.teardown();
    this.entry = entry;
    this.store.update((s) => {
      resetRoom(s);
      s.displayName = displayName;
      s.busy = true;
      if (entry.kind === "join") s.inviteCode = entry.code;
    });
    this.open();
  }

  private open(): void {
    this.closing = false;
    this.store.update((s) => { s.conn = this.attempt > 0 ? "reconnecting" : "connecting"; });
    this.transport = this.factory({
      onOpen: () => this.handleOpen(),
      onMessage: (raw) => this.handleMessage(raw),
      onClose: () => this.handleClose(),
    });
  }

  private teardown(): void {
    this.closing = true;
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
    this.store.update((s) => { s.conn = "open"; });
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      this.acks.expire(Date.now(), 60_000);
      this.send("ping", {});
    }, PING_MS);
    const s = this.store.state;
    const entry = this.entry;
    if (entry?.kind === "create") {
      this.send("create_room", { display_name: s.displayName });
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
    this.send("join_room", {
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
    if (!s.playerId && !this.entry) return;
    if (!s.playerId) {
      // never got into a room: report instead of retrying forever
      this.entry = null;
      this.store.update((st) => { st.conn = "closed"; st.busy = false; });
      this.hooks.notify("Could not reach the game server.");
      return;
    }
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
    if (msg.ack_id) this.acks.ack(msg.ack_id);
    this.store.apply(msg, Date.now());

    switch (msg.type) {
      case "room_created":
        // The creator then joins its own room like any other player.
        this.sendJoin(msg.payload.invite_code);
        break;
      case "joined": {
        const code = this.store.state.inviteCode;
        if (code) saveAuth(code, { auth_token: msg.payload.auth_token, player_id: msg.payload.player_id });
        break;
      }
      case "error":
        this.hooks.notify(msg.payload.message, "error");
        if (!this.store.state.playerId && ["not_found", "forbidden", "bad_message", "invalid_state"].includes(msg.payload.code)) {
          // a failed join: stay on the home screen
          const code = this.store.state.inviteCode;
          if (code && msg.payload.code === "forbidden") clearAuth(code);
          this.teardown();
          this.store.update((s) => { resetRoom(s); s.conn = "idle"; });
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
