import type {
  AuthUser, CampaignInfo, CharacterSummary, CombatState, CharacterView, EntityView, GameMap, Quest, ServerMessage,
} from "@aedm/schemas";

type Msg<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>["payload"];

export type ConnStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export interface RollInfo {
  who: string;
  label: string;
  dice: number[];
  modifier: number;
  total: number;
  target: number;
  outcome: "success" | "failure" | "crit" | "fumble";
}

export interface LogEntry {
  key: string;
  /** Bumped whenever the entry's content changes (streaming narration). */
  rev: number;
  kind: "narration" | "system" | "engine" | "roll" | "chat";
  channel?: "ic" | "ooc" | "system";
  who?: string;
  from_id?: string;
  text: string;
  /** Narration only: false while chunks are still arriving. */
  done?: boolean;
  roll?: RollInfo;
}

export interface TimedValue<T> {
  value: T;
  /** Wall-clock ms when the value arrived, so the UI can count down locally. */
  at: number;
}

export interface VoteView {
  vote_id: string;
  topic: string;
  options: string[];
  tally: Record<string, number>;
  seconds_left: number;
  at: number;
  myChoice: string | null;
}

/** The logged-in account, if any. Survives leaving a room. */
export interface AuthState {
  user: AuthUser | null;
  /** True from sending register/login/resume_session until the reply arrives. */
  pending: boolean;
  /** Last auth_error message, shown on the login form. */
  error: string | null;
  /** Saved character summaries. */
  characters: CharacterSummary[];
  /** Null until list_campaigns has been answered. */
  campaigns: CampaignInfo[] | null;
}

export const createAuthState = (): AuthState => ({ user: null, pending: false, error: null, characters: [], campaigns: null });

export interface AppState {
  auth: AuthState;
  conn: ConnStatus;
  mock: boolean;
  versionMismatch: boolean;
  /** True from pressing Host/Join until the room is joined or an error arrives. */
  busy: boolean;
  displayName: string;
  playerId: string | null;
  roomId: string | null;
  inviteCode: string | null;
  authToken: string | null;
  lobby: Msg<"lobby_state"> | null;
  myCharacterName: string | null;
  /** character_id -> player_id */
  claimed: Record<string, string>;
  seq: number;
  needsResync: boolean;
  mode: "exploration" | "combat";
  map: GameMap | null;
  entities: Record<string, EntityView>;
  party: CharacterView[];
  quests: Quest[];
  combat: CombatState | null;
  turnTimer: TimedValue<{ entity_id: string; seconds_left: number }> | null;
  vote: VoteView | null;
  log: LogEntry[];
  chips: string[];
}

export const MAX_LOG = 400;

export function createInitialState(): AppState {
  return {
    auth: createAuthState(),
    conn: "idle", mock: false, versionMismatch: false, busy: false,
    displayName: "", playerId: null, roomId: null, inviteCode: null, authToken: null,
    lobby: null, myCharacterName: null, claimed: {},
    seq: 0, needsResync: false, mode: "exploration", map: null, entities: {}, party: [], quests: [],
    combat: null, turnTimer: null, vote: null, log: [], chips: [],
  };
}

let logCounter = 0;

export function pushLog(s: AppState, entry: Omit<LogEntry, "key" | "rev"> & { key?: string }): LogEntry {
  const e: LogEntry = { ...entry, key: entry.key ?? `l${++logCounter}`, rev: 0 };
  s.log.push(e);
  if (s.log.length > MAX_LOG) s.log.splice(0, s.log.length - MAX_LOG);
  return e;
}

/** Reset everything tied to a room (leaving, or a fresh join). Keeps connection + name. */
export function resetRoom(s: AppState): void {
  const fresh = createInitialState();
  s.playerId = fresh.playerId; s.roomId = fresh.roomId; s.inviteCode = fresh.inviteCode; s.authToken = fresh.authToken;
  s.lobby = null; s.myCharacterName = null; s.claimed = {};
  s.seq = 0; s.needsResync = false; s.mode = "exploration"; s.map = null; s.entities = {}; s.party = [];
  s.quests = []; s.combat = null; s.turnTimer = null; s.vote = null; s.log = []; s.chips = [];
  s.busy = false;
}

/** The entity id of the local player's character, if it is on the map. */
export function myEntity(s: AppState): EntityView | null {
  if (!s.playerId) return null;
  for (const e of Object.values(s.entities)) if (e.kind === "pc" && e.owner_player_id === s.playerId) return e;
  const claimedId = Object.entries(s.claimed).find(([, p]) => p === s.playerId)?.[0];
  return claimedId ? (s.entities[claimedId] ?? null) : null;
}

export function myCharacter(s: AppState): CharacterView | null {
  const e = myEntity(s);
  return e ? (s.party.find((c) => c.id === e.id) ?? null) : null;
}

export function isHost(s: AppState): boolean {
  return !!s.playerId && s.lobby?.host_player_id === s.playerId;
}

export function nameOf(s: AppState, id: string): string {
  return s.entities[id]?.name ?? s.party.find((c) => c.id === id)?.name
    ?? s.lobby?.players.find((p) => p.player_id === id)?.display_name ?? id;
}

/** Apply one validated server message to the state, in place. `now` is wall-clock ms. */
export function applyServerMessage(s: AppState, msg: ServerMessage, now: number): void {
  switch (msg.type) {
    case "room_created":
      s.roomId = msg.payload.room_id;
      s.inviteCode = msg.payload.invite_code;
      return;
    case "joined":
      s.playerId = msg.payload.player_id;
      s.authToken = msg.payload.auth_token;
      s.roomId = msg.payload.room_id;
      s.busy = false;
      return;
    case "lobby_state": {
      s.lobby = msg.payload;
      s.roomId = msg.payload.room_id;
      s.inviteCode = msg.payload.invite_code;
      for (const p of msg.payload.players) if (p.character_id) s.claimed[p.character_id] = p.player_id;
      return;
    }
    case "presence": {
      const p = s.lobby?.players.find((x) => x.player_id === msg.payload.player_id);
      if (p) p.status = msg.payload.status;
      return;
    }
    case "character_claimed": {
      s.claimed[msg.payload.character_id] = msg.payload.player_id;
      const p = s.lobby?.players.find((x) => x.player_id === msg.payload.player_id);
      if (p) p.character_id = msg.payload.character_id;
      return;
    }
    case "state_snapshot": {
      const p = msg.payload;
      s.seq = p.seq; s.needsResync = false; s.mode = p.mode; s.map = p.map;
      s.entities = Object.fromEntries(p.entities.map((e) => [e.id, e]));
      s.party = p.party; s.quests = p.quests; s.combat = p.combat ?? null;
      if (!s.combat) s.turnTimer = null;
      return;
    }
    case "state_diff": {
      const p = msg.payload;
      if (p.seq <= s.seq) return; // stale or duplicate
      if (p.seq > s.seq + 1) s.needsResync = true; // gap: caller may ask for a fresh snapshot
      s.seq = p.seq;
      for (const e of p.changed) s.entities[e.id] = e;
      for (const id of p.removed) delete s.entities[id];
      if (p.mode) s.mode = p.mode;
      if (p.combat) s.combat = p.combat;
      if (s.mode === "exploration") { s.combat = null; s.turnTimer = null; }
      return;
    }
    case "combat_state":
      s.combat = msg.payload;
      s.mode = "combat";
      return;
    case "turn_timer":
      s.turnTimer = { value: { entity_id: msg.payload.entity_id, seconds_left: msg.payload.seconds_left }, at: now };
      return;
    case "narration_chunk": {
      const key = `n:${msg.payload.turn_id}`;
      let e = s.log.find((l) => l.key === key);
      if (!e) e = pushLog(s, { key, kind: "narration", text: "", done: false });
      e.text += msg.payload.text;
      e.done = msg.payload.done;
      e.rev++;
      return;
    }
    case "roll_result": {
      const p = msg.payload;
      pushLog(s, { kind: "roll", text: p.label, who: p.who, roll: { ...p } });
      return;
    }
    case "chat":
      pushLog(s, { kind: "chat", channel: msg.payload.channel, who: msg.payload.from_name, from_id: msg.payload.from_id, text: msg.payload.text });
      return;
    case "log": {
      const k = msg.payload.kind;
      pushLog(s, { kind: k === "roll" ? "engine" : k, text: msg.payload.text, done: true });
      return;
    }
    case "chips":
      s.chips = msg.payload.chips;
      return;
    case "vote_state": {
      const p = msg.payload;
      if (p.seconds_left <= 0) { s.vote = null; return; }
      const prev = s.vote?.vote_id === p.vote_id ? s.vote : null;
      s.vote = { vote_id: p.vote_id, topic: p.topic, options: p.options, tally: p.tally, seconds_left: p.seconds_left, at: now, myChoice: prev?.myChoice ?? null };
      return;
    }
    case "error":
      // Surfaced as a toast by the client; also clears a pending "busy" join.
      s.busy = false;
      return;
    case "auth_ok":
      s.auth.user = msg.payload.user;
      s.auth.characters = msg.payload.characters;
      s.auth.pending = false;
      s.auth.error = null;
      if (!s.displayName) s.displayName = msg.payload.user.display_name;
      return;
    case "auth_error":
      s.auth.pending = false;
      s.auth.error = msg.payload.message;
      return;
    case "logged_out":
      s.auth = createAuthState();
      return;
    case "characters_list":
      s.auth.characters = msg.payload.characters;
      return;
    case "campaigns_list":
      s.auth.campaigns = msg.payload.campaigns;
      return;
    case "map_load":
    case "save_created":
    case "pong":
      return;
  }
}

type Listener = (s: AppState) => void;

/** Minimal observable store. Mutate through `update`, which notifies subscribers. */
export class Store {
  readonly state: AppState;
  private listeners = new Set<Listener>();

  constructor(initial: AppState = createInitialState()) {
    this.state = initial;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  update(fn: (s: AppState) => void): void {
    fn(this.state);
    for (const l of [...this.listeners]) l(this.state);
  }

  apply(msg: ServerMessage, now: number): void {
    this.update((s) => applyServerMessage(s, msg, now));
  }
}
