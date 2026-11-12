import {
  ClientMessageSchema, WS_VERSION, exceedsMaxBytes, type ClientMessage,
} from "@aedm/schemas";
import type { ModelProvider } from "@aedm/llm";
import type { AccountStore } from "./accounts/store";
import type { WorkshopStore } from "./accounts/workshop";
import { createSpriteAssets } from "./assets/sprites";
import type { AssetStore } from "./assets/store";
import { Handlers } from "./handlers";
import { Conn, type Socket } from "./net";
import type { RoomRegistry } from "./rooms";
import type { SaveStore } from "./saves";
import {
  DEFAULT_CONFIG, consoleLogger, realTimers, type Deps, type ServerConfig, type Logger, type Timers,
} from "./types";

/** Everything the game needs, with no Node-only parts: storage and the model come in from the host (Node server or Cloudflare). */
export interface GameCoreOptions {
  provider: ModelProvider;
  saves: SaveStore;
  accounts: AccountStore;
  workshop: WorkshopStore;
  assets: AssetStore;
  /** How long the sprite designer model gets before the offline designer answers (default 4000). */
  spriteTimeoutMs?: number;
  clock?: () => number;
  random?: () => number;
  timers?: Timers;
  config?: Partial<Omit<ServerConfig, "limits">> & { limits?: Partial<ServerConfig["limits"]> };
  logger?: Logger;
}

/** What a host calls for one accepted socket. */
export interface ConnectionHandle {
  /** A text frame. */
  message(raw: string): void;
  /** A binary frame (refused with an error to the client). */
  binary(): void;
  closed(): void;
}

export interface GameCore {
  accept(socket: Socket): ConnectionHandle;
  /** Debug and test access to the live rooms. */
  readonly rooms: RoomRegistry;
  /** Closes every connection and stops every timer. */
  shutdown(): Promise<void>;
}

/** Largest text frame a host should accept, in bytes. */
export const MAX_FRAME_BYTES = 256 * 1024;

function guessAckId(json: unknown): string | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const id = (json as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 && id.length <= 64 ? id : undefined;
}

export function createGameCore(opts: GameCoreOptions): GameCore {
  const config: ServerConfig = {
    ...DEFAULT_CONFIG,
    ...opts.config,
    limits: { ...DEFAULT_CONFIG.limits, ...opts.config?.limits },
  };
  const clock = opts.clock ?? Date.now;
  const timers = opts.timers ?? realTimers;
  const logger = opts.logger ?? consoleLogger;
  const deps: Deps = {
    provider: opts.provider,
    sprites: createSpriteAssets({ store: opts.assets, provider: opts.provider, timers, clock, logger, ...(opts.spriteTimeoutMs ? { timeoutMs: opts.spriteTimeoutMs } : {}) }),
    saves: opts.saves,
    accounts: opts.accounts,
    workshop: opts.workshop,
    clock,
    random: opts.random ?? Math.random,
    timers,
    config,
    logger,
  };
  const handlers = new Handlers(deps);
  const conns = new Set<Conn>();

  function handleRaw(conn: Conn, raw: string): void {
    if (exceedsMaxBytes(raw)) {
      let ack: string | undefined;
      try { ack = guessAckId(JSON.parse(raw)); } catch { /* not JSON */ }
      conn.error("bad_message", "That message is too large (8 KB maximum).", ack);
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      conn.error("bad_message", "That message was not valid JSON.");
      return;
    }
    const ack = guessAckId(json);
    if (typeof json === "object" && json !== null && (json as { v?: unknown }).v !== WS_VERSION) {
      conn.error("version_mismatch", "Your game is out of date. Please reload the page.", ack);
      return;
    }
    const parsed = ClientMessageSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      conn.error("bad_message", `Invalid message${issue ? `: ${issue.path.join(".") || "(root)"} ${issue.message}` : ""}`.slice(0, 400), ack);
      return;
    }
    const msg: ClientMessage = parsed.data;
    if (conn.recent.seen(msg.id)) return; // idempotent: a duplicate id is ignored

    const now = deps.clock();
    const lim = config.limits;
    const allowed =
      msg.type === "move_intent" ? conn.limiter.allow("move", now, lim.movePerSec, 1000)
      : msg.type === "say" ? conn.limiter.allow("say", now, 1, lim.sayIntervalMs)
      : conn.limiter.allow("other", now, lim.otherPerSec, 1000);
    if (!allowed) {
      conn.error("rate_limited", "You are doing that too quickly.", msg.id);
      return;
    }
    handlers.dispatch(conn, msg).catch((err: unknown) => {
      deps.logger.error(`[server] handler ${msg.type} failed:`, err instanceof Error ? err.message : String(err));
      conn.error("internal_error", "Something went wrong on the server.", msg.id);
    });
  }

  return {
    rooms: handlers.registry,
    accept(socket) {
      const conn = new Conn(socket, clock);
      conns.add(conn);
      return {
        message(raw) {
          try {
            handleRaw(conn, raw);
          } catch (err) {
            deps.logger.error("[server] message failed:", err instanceof Error ? err.message : String(err));
            conn.error("internal_error", "Something went wrong on the server.");
          }
        },
        binary() {
          conn.error("bad_message", "Binary messages are not supported.");
        },
        closed() {
          conns.delete(conn);
          try { handlers.onClose(conn); } catch (err) { deps.logger.error("[server] close failed:", err instanceof Error ? err.message : String(err)); }
        },
      };
    },
    async shutdown() {
      for (const c of conns) c.close();
      await handlers.shutdown();
    },
  };
}
