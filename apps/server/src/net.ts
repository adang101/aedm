import { WS_VERSION, type Ability, type ServerMessageType } from "@aedm/schemas";

/** Bounded set of recently seen message ids (idempotency). */
export class RecentIds {
  private readonly ids = new Set<string>();
  constructor(private readonly max = 512) {}
  /** True if `id` was already seen; otherwise remembers it. */
  seen(id: string): boolean {
    if (this.ids.has(id)) return true;
    this.ids.add(id);
    if (this.ids.size > this.max) {
      const first = this.ids.values().next().value;
      if (first !== undefined) this.ids.delete(first);
    }
    return false;
  }
}

/** Sliding-window rate limiter keyed by bucket name. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  /** Returns true if the action is allowed (and records it). */
  allow(bucket: string, now: number, max: number, windowMs: number): boolean {
    const arr = (this.hits.get(bucket) ?? []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      this.hits.set(bucket, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(bucket, arr);
    return true;
  }
}

/** The little a connection needs from a socket, so Node's `ws` and Cloudflare's WebSocket both fit. */
export interface Socket {
  readonly open: boolean;
  send(data: string): void;
  close(): void;
}

let nextConnId = 1;
let nextMsgId = 1;

/** One WebSocket connection and what it is bound to. */
export class Conn {
  readonly id = nextConnId++;
  playerId: string | null = null;
  roomId: string | null = null;
  /** Set by register, login or resume_session. */
  userId: string | null = null;
  /** The session token this connection authenticated with (so logout can delete it). */
  sessionToken: string | null = null;
  /** The last forge result for this connection, so "Save to my characters" can keep the forged abilities. */
  lastForged: { name: string; abilities: Ability[] } | null = null;
  readonly recent = new RecentIds();
  readonly limiter = new RateLimiter();

  constructor(readonly socket: Socket, private readonly clock: () => number) {}

  get open(): boolean {
    return this.socket.open;
  }

  send(type: ServerMessageType, payload: unknown, ackId?: string): void {
    if (!this.open) return;
    const msg = { v: WS_VERSION, type, id: `s${nextMsgId++}`, ts: this.clock(), payload, ...(ackId ? { ack_id: ackId } : {}) };
    try {
      this.socket.send(JSON.stringify(msg));
    } catch {
      /* socket died between the check and the send: the close handler cleans up */
    }
  }

  error(code: string, message: string, ackId?: string): void {
    this.send("error", { code, message, ...(ackId ? { ack_id: ackId } : {}) }, ackId);
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      /* ignore */
    }
  }
}
