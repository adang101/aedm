import { DurableObject } from "cloudflare:workers";
import { createProviderFromEnv, formatUsageLine, registerPrompts, UsageLedger, withUsageLedger } from "@aedm/llm";
import { JsonAccountStore } from "@aedm/server/src/accounts/store";
import { JsonWorkshopStore } from "@aedm/server/src/accounts/workshop";
import { JsonAssetStore } from "@aedm/server/src/assets/store";
import { MAX_FRAME_BYTES, createGameCore, type GameCore } from "@aedm/server/src/core";
import { KvSaveStore } from "@aedm/server/src/saves";
import { DoKv, type StorageLike } from "./do-kv";
import { PROMPTS } from "./prompts";
import type { Env } from "./env";

/** The Worker env mixes settings with bindings (objects); the provider factory wants only the strings. */
function stringSettings(env: Env): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string"));
}

/** Namespaces inside the one storage, so the stores' keys cannot collide. */
function prefixed(kv: DoKv, prefix: string) {
  return {
    get: (k: string) => kv.get(`${prefix}/${k}`),
    put: (k: string, v: string) => kv.put(`${prefix}/${k}`, v),
    list: async (p = "") => (await kv.list(`${prefix}/${p}`)).map((k) => k.slice(prefix.length + 1)),
  };
}

/**
 * The whole game server in one Durable Object: every room, account and timer lives here, so invite codes resolve
 * without a lookup service. One object is one thread, which is plenty for a few tables; sharding by room is the
 * next step if it is ever needed. WebSockets are accepted without hibernation, because rooms hold live timers and
 * in-memory state. Autosaves (see game.ts) are what survive the object being evicted.
 */
export class GameHub extends DurableObject<Env> {
  private core: GameCore | null = null;

  private getCore(): GameCore {
    if (this.core) return this.core;
    registerPrompts(PROMPTS);
    const kv = new DoKv(this.ctx.storage as unknown as StorageLike);
    this.core = createGameCore({
      // Logs token counts per model call (never prompt text or keys) so usage shows in Worker logs.
      provider: withUsageLedger(createProviderFromEnv(stringSettings(this.env)), new UsageLedger(), (purpose, usage) => console.log(formatUsageLine(purpose, usage))),
      saves: new KvSaveStore(prefixed(kv, "saves")),
      accounts: new JsonAccountStore({ kv: prefixed(kv, "accounts") }),
      workshop: new JsonWorkshopStore({ kv: prefixed(kv, "workshop") }),
      assets: new JsonAssetStore({ kv: prefixed(kv, "assets") }),
      config: { devLog: this.env.AEDM_DEV_LOG === "1" },
    });
    return this.core;
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket upgrade", { status: 426 });
    let core: GameCore;
    try {
      core = this.getCore();
    } catch (err) {
      console.error("[hub] cannot start:", err instanceof Error ? err.message : String(err));
      return new Response("The game server is misconfigured.", { status: 500 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    const conn = core.accept({
      get open() { return server.readyState === WebSocket.READY_STATE_OPEN; },
      send: (data) => server.send(data),
      close: () => server.close(1000, "closed"),
    });
    let ended = false;
    const end = (): void => {
      if (ended) return;
      ended = true;
      conn.closed();
    };
    server.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") conn.binary();
      else if (ev.data.length > MAX_FRAME_BYTES) server.close(1009, "message too big");
      else conn.message(ev.data);
    });
    server.addEventListener("close", end);
    server.addEventListener("error", end);
    return new Response(null, { status: 101, webSocket: client });
  }
}
