import {
  ClientMessageSchema, WS_VERSION, exceedsMaxBytes, type ClientMessage,
} from "@aedm/schemas";
import type { ModelProvider } from "@aedm/llm";
import { join } from "node:path";
import { WebSocketServer, type RawData } from "ws";
import { JsonAccountStore, type AccountStore } from "./accounts/store";
import { JsonWorkshopStore, type WorkshopStore } from "./accounts/workshop";
import { createSpriteAssets } from "./assets/sprites";
import { JsonAssetStore, type AssetStore } from "./assets/store";
import { Handlers } from "./handlers";
import { Conn } from "./net";
import type { RoomRegistry } from "./rooms";
import {
  DEFAULT_CONFIG, consoleLogger, realTimers, type Deps, type Logger, type ServerConfig, type Timers,
} from "./types";

export interface GameServerOptions {
  /** 0 picks a free port (tests). Default 8787. */
  port?: number;
  host?: string;
  provider: ModelProvider;
  saveDir: string;
  /** Folder for account files (default: a hidden folder inside saveDir). */
  dataDir?: string;
  /** Replace the JSON-file account storage (a database, or a fake in tests). */
  accounts?: AccountStore;
  /** Replace the JSON-file Workshop storage (<dataDir>/accounts/workshop/<user>.json). */
  workshop?: WorkshopStore;
  /** Replace the JSON-file asset storage (<dataDir>/assets/assets.json). */
  assets?: AssetStore;
  /** How long the sprite designer model gets before the offline designer answers (default 4000). */
  spriteTimeoutMs?: number;
  clock?: () => number;
  random?: () => number;
  timers?: Timers;
  config?: Partial<Omit<ServerConfig, "limits">> & { limits?: Partial<ServerConfig["limits"]> };
  logger?: Logger;
}

export interface GameServer {
  /** The port actually listening. */
  port: number;
  close(): Promise<void>;
  /** Debug and test access to the live rooms. */
  readonly rooms: RoomRegistry;
}

const MAX_FRAME_BYTES = 256 * 1024;

function guessAckId(json: unknown): string | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const id = (json as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 && id.length <= 64 ? id : undefined;
}

export async function createGameServer(opts: GameServerOptions): Promise<GameServer> {
  const config: ServerConfig = {
    ...DEFAULT_CONFIG,
    ...opts.config,
    limits: { ...DEFAULT_CONFIG.limits, ...opts.config?.limits },
  };
  const clock = opts.clock ?? Date.now;
  const timers = opts.timers ?? realTimers;
  const logger = opts.logger ?? consoleLogger;
  const assets = opts.assets ?? new JsonAssetStore({ dir: join(opts.dataDir ?? join(opts.saveDir, ".data"), "assets") });
  const deps: Deps = {
    provider: opts.provider,
    sprites: createSpriteAssets({ store: assets, provider: opts.provider, timers, clock, logger, ...(opts.spriteTimeoutMs ? { timeoutMs: opts.spriteTimeoutMs } : {}) }),
    saveDir: opts.saveDir,
    accounts: opts.accounts ?? new JsonAccountStore({ dir: join(opts.dataDir ?? join(opts.saveDir, ".data"), "accounts"), clock: opts.clock }),
    workshop: opts.workshop ?? new JsonWorkshopStore({ dir: join(opts.dataDir ?? join(opts.saveDir, ".data"), "accounts", "workshop"), ...(opts.clock ? { clock: opts.clock } : {}) }),
    clock: opts.clock ?? Date.now,
    random: opts.random ?? Math.random,
    timers: opts.timers ?? realTimers,
    config,
    logger: opts.logger ?? consoleLogger,
  };
  const handlers = new Handlers(deps);
  const conns = new Set<Conn>();

  const wss = new WebSocketServer({ port: opts.port ?? 8787, host: opts.host, maxPayload: MAX_FRAME_BYTES });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", () => resolve());
    wss.once("error", reject);
  });

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

  wss.on("connection", (ws) => {
    const conn = new Conn(ws, deps.clock);
    conns.add(conn);
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        conn.error("bad_message", "Binary messages are not supported.");
        return;
      }
      try {
        handleRaw(conn, data.toString("utf8"));
      } catch (err) {
        deps.logger.error("[server] message failed:", err instanceof Error ? err.message : String(err));
        conn.error("internal_error", "Something went wrong on the server.");
      }
    });
    ws.on("close", () => {
      conns.delete(conn);
      try { handlers.onClose(conn); } catch (err) { deps.logger.error("[server] close failed:", err instanceof Error ? err.message : String(err)); }
    });
    ws.on("error", () => { /* the close event follows */ });
  });

  const address = wss.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 8787);

  return {
    port,
    rooms: handlers.registry,
    async close() {
      for (const c of conns) c.close();
      await handlers.shutdown();
      await new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      });
    },
  };
}
