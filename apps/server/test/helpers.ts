import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeProvider, type FakeProvider, type ModelProvider, type ModelRequest } from "@aedm/llm";
import { ServerMessageSchema, WS_VERSION, type CharacterCreate, type ServerMessage } from "@aedm/schemas";
import WebSocket from "ws";
import { createGameServer, type GameServer, type GameServerOptions } from "../src/server";
import { silentLogger } from "../src/types";

export const FAST: NonNullable<GameServerOptions["config"]> = {
  beatWindowMs: 60,
  moveStepMs: 5,
  aiStepMs: 5,
  turnMs: 60_000,
  turnTickMs: 20,
  voteMs: 300,
  disconnectGraceMs: 40,
  retryBackoffMs: 5,
  limits: { otherPerSec: 1000, movePerSec: 1000, sayIntervalMs: 0 },
};

export const NARRATION =
  "Mist coils across the square as the lanterns gutter and steady again. Somewhere beyond the rooftops a bell tolls once, " +
  "and the villagers pause to listen. The party gathers close, boots wet with marsh water, each of them aware that the night " +
  "has only just begun and that the road ahead is long.";

export function dmReply(actions: unknown[] = [], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ v: 1, narration: NARRATION, actions, importance: 2, high_stakes: false, ...extra });
}

export interface Scripted extends FakeProvider {
  /** Queue DM replies; consumed in order by dm-purpose requests (everything else uses the offline improv). */
  queueDm(...replies: string[]): void;
  dmRequests(): ModelRequest[];
}

/** Fake provider: scripted DM replies first, offline improv for everything else (forge, enemy, bible, summary). */
export function scriptedProvider(): Scripted {
  const improv = createFakeProvider();
  const queue: string[] = [];
  const p = createFakeProvider(async (req) => {
    if (req.purpose === "dm" && queue.length > 0) return queue.shift() as string;
    return (await improv.complete(req)).text;
  }) as Scripted;
  p.queueDm = (...r) => { queue.push(...r); };
  p.dmRequests = () => p.requests.filter((r) => r.purpose === "dm");
  return p;
}

export interface Harness {
  server: GameServer;
  provider: ModelProvider;
  saveDir: string;
  dataDir: string;
  url: string;
  clients: TestClient[];
  connect(): Promise<TestClient>;
  stop(): Promise<void>;
}

export async function startHarness(opts: { provider?: ModelProvider; config?: GameServerOptions["config"]; random?: () => number } = {}): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), "aedm-data-"));
  const saveDir = join(dataDir, "saves");
  const provider = opts.provider ?? createFakeProvider();
  const server = await createGameServer({
    port: 0, host: "127.0.0.1", provider, saveDir, dataDir, logger: silentLogger,
    config: { ...FAST, ...opts.config, limits: { ...FAST.limits, ...opts.config?.limits } },
    ...(opts.random ? { random: opts.random } : {}),
  });
  const url = `ws://127.0.0.1:${server.port}`;
  const clients: TestClient[] = [];
  return {
    server, provider, saveDir, dataDir, url, clients,
    async connect() {
      const c = await TestClient.connect(url);
      clients.push(c);
      return c;
    },
    async stop() {
      for (const c of clients) c.close();
      await server.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

type Pred = (m: ServerMessage) => boolean;

export class TestClient {
  readonly msgs: ServerMessage[] = [];
  readonly invalid: string[] = [];
  private n = 0;
  private waiters: { pred: Pred; from: number; resolve: (m: ServerMessage) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];
  playerId = "";
  token = "";
  code = "";

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const json = JSON.parse(data.toString());
      const parsed = ServerMessageSchema.safeParse(json);
      if (!parsed.success) {
        this.invalid.push(`${json?.type}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
        return;
      }
      this.msgs.push(parsed.data);
      const idx = this.msgs.length - 1;
      for (const w of [...this.waiters]) {
        if (idx >= w.from && w.pred(parsed.data)) {
          clearTimeout(w.timer);
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(parsed.data);
        }
      }
    });
  }

  static connect(url: string): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const c = new TestClient(ws);
      ws.once("open", () => resolve(c));
      ws.once("error", reject);
    });
  }

  close(): void { this.ws.close(); }

  /** Index to pass as `from` so only later messages match. */
  mark(): number { return this.msgs.length; }

  send(type: string, payload: unknown = {}, id?: string): string {
    const mid = id ?? `t${++this.n}`;
    this.ws.send(JSON.stringify({ v: WS_VERSION, type, id: mid, ts: Date.now(), payload }));
    return mid;
  }

  sendRaw(raw: string): void { this.ws.send(raw); }

  wait<T extends ServerMessage["type"]>(
    type: T, pred: (p: Extract<ServerMessage, { type: T }>["payload"], m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
    opts: { from?: number; timeout?: number } = {},
  ): Promise<Extract<ServerMessage, { type: T }>> {
    return this.waitMsg((m) => m.type === type && pred(m.payload as never, m as never), opts) as Promise<Extract<ServerMessage, { type: T }>>;
  }

  waitMsg(pred: Pred, opts: { from?: number; timeout?: number } = {}): Promise<ServerMessage> {
    const from = opts.from ?? 0;
    for (let i = from; i < this.msgs.length; i++) if (pred(this.msgs[i] as ServerMessage)) return Promise.resolve(this.msgs[i] as ServerMessage);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const w = this.waiters.findIndex((x) => x.timer === timer);
        if (w >= 0) this.waiters.splice(w, 1);
        reject(new Error(`timed out waiting for a message; saw: ${this.msgs.slice(from).map((m) => m.type).join(",")}`));
      }, opts.timeout ?? 4000);
      this.waiters.push({ pred, from, resolve, reject, timer });
    });
  }

  all<T extends ServerMessage["type"]>(type: T, from = 0): Extract<ServerMessage, { type: T }>[] {
    return this.msgs.slice(from).filter((m) => m.type === type) as Extract<ServerMessage, { type: T }>[];
  }

  /** Send and wait for the reply carrying our ack_id (either the success reply or an error). */
  async request(type: string, payload: unknown = {}): Promise<ServerMessage> {
    const from = this.mark();
    const id = this.send(type, payload);
    return this.waitMsg((m) => m.ack_id === id, { from });
  }

  async createAndJoin(name: string): Promise<string> {
    const created = await this.request("create_room", { display_name: name });
    if (created.type !== "room_created") throw new Error(`create_room failed: ${JSON.stringify(created)}`);
    this.code = created.payload.invite_code;
    await this.join(this.code, name);
    return this.code;
  }

  async join(code: string, name: string, token?: string): Promise<ServerMessage> {
    const r = await this.request("join_room", { invite_code: code, display_name: name, ...(token ? { auth_token: token } : {}) });
    if (r.type === "joined") {
      this.playerId = r.payload.player_id;
      this.token = r.payload.auth_token;
      this.code = code;
    }
    return r;
  }

  lastLobby() {
    const l = this.all("lobby_state");
    return l[l.length - 1]?.payload;
  }

  lastSnapshot() {
    const s = this.all("state_snapshot");
    return s[s.length - 1]?.payload;
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function brindle(name = "Brindle Ash"): CharacterCreate {
  return {
    v: 1, name, title: "demolitions expert",
    description: "A soot-streaked tinkerer with a satchel of fuses and a patient smile.",
    key_ability: "int",
    scores: { str: 10, dex: 13, con: 14, int: 15, wis: 10, cha: 10 },
    trait_tags: ["explosives", "crafting"],
    sprite_recipe: { kind: "shape", shape: "hex", color: "#c0562b", accent: "#3a2a1e", glyph: "B" },
    ability_texts: [
      "Shaped Charge: Plant and detonate a directional charge. It blasts a small area and stuns anyone caught in it.",
      "Tripwire Cache: Lay a hidden tripwire across a corridor. The first enemy to cross it takes a nasty cut.",
      "Smoke Pop: Throw a smoke bomb that blocks sight in a small area for a couple of turns.",
    ],
  };
}

export function tamsin(name = "Tamsin Quickfoot"): CharacterCreate {
  return {
    v: 1, name, title: "courier and speedster",
    description: "A wiry courier who is never quite where you last saw her.",
    key_ability: "dex",
    scores: { str: 8, dex: 15, con: 12, int: 12, wis: 13, cha: 13 },
    trait_tags: ["speed", "stealth"],
    sprite_recipe: { kind: "shape", shape: "triangle", color: "#3f7fbf", accent: "#f2d45c", glyph: "T" },
    ability_texts: [
      "Blink Rush: Dash up to four tiles in a line and strike the first enemy I reach.",
      "Slipstream: Give an ally a burst of speed for two turns.",
    ],
  };
}

export interface Table {
  a: TestClient;
  b: TestClient;
  code: string;
}

/** Two players in a lobby with characters claimed and ready. */
export async function lobbyOfTwo(h: Harness): Promise<Table> {
  const a = await h.connect();
  const b = await h.connect();
  const code = await a.createAndJoin("Alice");
  await b.join(code, "Bob");
  const ra = await a.request("claim_character", { character_id: "new", character: brindle() });
  if (ra.type !== "character_claimed") throw new Error(`A claim failed: ${JSON.stringify(ra)}`);
  const rb = await b.request("claim_character", { character_id: "new", character: tamsin() });
  if (rb.type !== "character_claimed") throw new Error(`B claim failed: ${JSON.stringify(rb)}`);
  await a.request("set_ready", { ready: true });
  await b.request("set_ready", { ready: true });
  return { a, b, code };
}

/** Lobby of two, then start the game and wait for the opening narration to finish on both clients. */
export async function startedTable(h: Harness): Promise<Table> {
  const t = await lobbyOfTwo(h);
  const ma = t.a.mark();
  const mb = t.b.mark();
  const r = await t.a.request("start_game", {});
  if (r.type === "error") throw new Error(`start_game failed: ${JSON.stringify(r.payload)}`);
  await t.a.wait("state_snapshot", () => true, { from: ma });
  await t.b.wait("state_snapshot", () => true, { from: mb });
  await t.a.wait("narration_chunk", (p) => p.done, { from: ma });
  await t.b.wait("narration_chunk", (p) => p.done, { from: mb });
  return t;
}
