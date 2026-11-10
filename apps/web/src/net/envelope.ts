import { WS_VERSION } from "@aedm/schemas";

export interface Envelope<T extends string = string, P = unknown> {
  v: typeof WS_VERSION;
  type: T;
  id: string;
  ts: number;
  payload: P;
}

/** Unique-per-session id generator. `nonce` makes ids distinct across reloads. */
export function createIdGenerator(nonce: string): () => string {
  let n = 0;
  return () => `c-${nonce}-${++n}`;
}

export function makeEnvelope<T extends string, P>(type: T, payload: P, id: string, ts: number): Envelope<T, P> {
  return { v: WS_VERSION, type, id, ts, payload };
}

/** Delay before reconnect attempt `attempt` (0-based): exponential from 500 ms, capped at 10 s, with jitter in [0.5, 1]. */
export function backoffDelay(attempt: number, rand: number): number {
  const base = Math.min(10_000, 500 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.5 + rand * 0.5));
}

/** Tracks messages awaiting a server `ack_id`. */
export class AckTracker {
  private pending = new Map<string, { type: string; sentAt: number }>();

  track(id: string, type: string, now: number): void {
    this.pending.set(id, { type, sentAt: now });
  }

  /** Returns the acknowledged entry, or undefined if unknown. */
  ack(id: string): { type: string; sentAt: number } | undefined {
    const e = this.pending.get(id);
    this.pending.delete(id);
    return e;
  }

  get size(): number {
    return this.pending.size;
  }

  /** Drop entries older than `maxAgeMs`; returns how many were dropped. */
  expire(now: number, maxAgeMs: number): number {
    let n = 0;
    for (const [id, e] of this.pending) if (now - e.sentAt > maxAgeMs) { this.pending.delete(id); n++; }
    return n;
  }

  clear(): void {
    this.pending.clear();
  }
}
