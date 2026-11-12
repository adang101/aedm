import { join } from "node:path";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { JsonAccountStore, type AccountStore } from "./accounts/store";
import { JsonWorkshopStore, type WorkshopStore } from "./accounts/workshop";
import { JsonAssetStore, type AssetStore } from "./assets/store";
import { MAX_FRAME_BYTES, createGameCore, type GameCoreOptions } from "./core";
import type { Socket } from "./net";
import type { RoomRegistry } from "./rooms";
import { fsSaveStore, type SaveStore } from "./saves";

export interface GameServerOptions extends Pick<GameCoreOptions, "provider" | "spriteTimeoutMs" | "clock" | "random" | "timers" | "config" | "logger"> {
  /** 0 picks a free port (tests). Default 8787. */
  port?: number;
  host?: string;
  saveDir: string;
  /** Folder for account files (default: a hidden folder inside saveDir). */
  dataDir?: string;
  /** Replace the JSON-file save storage (<saveDir>/<room>/<save>.json). */
  saves?: SaveStore;
  /** Replace the JSON-file account storage (a database, or a fake in tests). */
  accounts?: AccountStore;
  /** Replace the JSON-file Workshop storage (<dataDir>/accounts/workshop/<user>.json). */
  workshop?: WorkshopStore;
  /** Replace the JSON-file asset storage (<dataDir>/assets/assets.json). */
  assets?: AssetStore;
}

export interface GameServer {
  /** The port actually listening. */
  port: number;
  close(): Promise<void>;
  /** Debug and test access to the live rooms. */
  readonly rooms: RoomRegistry;
}

function wsSocket(ws: WebSocket): Socket {
  return {
    get open() { return ws.readyState === WebSocket.OPEN; },
    send: (data) => ws.send(data),
    close: () => ws.close(),
  };
}

/** The Node host: a `ws` server over the game core, with JSON files for storage. */
export async function createGameServer(opts: GameServerOptions): Promise<GameServer> {
  const dataDir = opts.dataDir ?? join(opts.saveDir, ".data");
  const core = createGameCore({
    provider: opts.provider,
    saves: opts.saves ?? fsSaveStore(opts.saveDir),
    accounts: opts.accounts ?? new JsonAccountStore({ dir: join(dataDir, "accounts"), clock: opts.clock }),
    workshop: opts.workshop ?? new JsonWorkshopStore({ dir: join(dataDir, "accounts", "workshop"), ...(opts.clock ? { clock: opts.clock } : {}) }),
    assets: opts.assets ?? new JsonAssetStore({ dir: join(dataDir, "assets") }),
    ...(opts.spriteTimeoutMs ? { spriteTimeoutMs: opts.spriteTimeoutMs } : {}),
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...(opts.random ? { random: opts.random } : {}),
    ...(opts.timers ? { timers: opts.timers } : {}),
    ...(opts.config ? { config: opts.config } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });

  const wss = new WebSocketServer({ port: opts.port ?? 8787, host: opts.host, maxPayload: MAX_FRAME_BYTES });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", () => resolve());
    wss.once("error", reject);
  });

  wss.on("connection", (ws) => {
    const conn = core.accept(wsSocket(ws));
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) conn.binary();
      else conn.message(data.toString("utf8"));
    });
    ws.on("close", () => conn.closed());
    ws.on("error", () => { /* the close event follows */ });
  });

  const address = wss.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 8787);

  return {
    port,
    rooms: core.rooms,
    async close() {
      await core.shutdown();
      await new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      });
    },
  };
}
