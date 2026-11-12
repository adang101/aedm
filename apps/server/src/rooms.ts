import { randomBytes } from "node:crypto";
import { createGameState, type GameState } from "@aedm/engine";
import { LANTERN_MARSH_BIBLE } from "@aedm/llm";
import type { CastEntry, PlayerStatus, RoomSettings, ServerMessageType, SpriteRecipe, SpriteRoleHint } from "@aedm/schemas";
import type { GameSession } from "./game";
import type { Conn } from "./net";
import type { Deps } from "./types";

/** No I, L, O, 0 or 1: nothing that reads two ways over voice chat. */
export const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const INVITE_LENGTH = 6;

export interface Player {
  id: string;
  name: string;
  /** Secret reconnect token, per player per room. */
  token: string;
  /** The account this seat belongs to, if the player was logged in. */
  userId: string | null;
  conn: Conn | null;
  status: PlayerStatus;
  ready: boolean;
  characterId: string | null;
  /** True while the ability forge is running for this player's claim. */
  forging: boolean;
  graceTimer: unknown;
}

export const DEFAULT_SETTINGS: RoomSettings = {
  content_rating: "teen", campaign_pitch: "", dev_solo: false, plot_pattern: "auto", plot_arc: "auto",
  custom_cast: "host_approval", custom_paintings: true,
};

/** A Workshop sprite offered to this campaign. The recipe is a snapshot taken at the offer, so later Workshop edits or deletes do not change the table. */
export interface CastItem {
  assetId: string;
  ownerPlayerId: string;
  name: string;
  roleHint: SpriteRoleHint;
  concept: string;
  recipe: SpriteRecipe;
  status: "pending" | "approved";
}

export class Room {
  hostId: string | null = null;
  phase: "lobby" | "playing" = "lobby";
  settings: RoomSettings = { ...DEFAULT_SETTINGS };
  readonly players: Player[] = [];
  /** Pre-game holder: claimed characters live here (validated by the engine) until the game starts. */
  scratch: GameState;
  game: GameSession | null = null;
  starting = false;
  idleTimer: unknown = null;
  /** Account that owns the campaign (set when a room is opened with resume_campaign). */
  ownerUserId: string | null = null;
  /** Sprites players offered to the campaign (see CastItem). Not part of saves: it belongs to the table. */
  cast: CastItem[] = [];
  /** Set by resume_campaign: where the save to load lives. */
  resume: { roomId: string; saveId: string; name: string } | null = null;

  constructor(
    readonly id: string,
    readonly code: string,
    /** Only this connection may take the first seat (and with it, the host role). */
    readonly creatorConnId: number,
  ) {
    this.scratch = createGameState({ seed: 1, bible: LANTERN_MARSH_BIBLE, facts: [], contentRating: this.settings.content_rating });
  }

  player(id: string | null | undefined): Player | undefined {
    return id ? this.players.find((p) => p.id === id) : undefined;
  }

  playerByToken(token: string): Player | undefined {
    return this.players.find((p) => p.token === token);
  }

  playerByUser(userId: string | null | undefined): Player | undefined {
    return userId ? this.players.find((p) => p.userId === userId) : undefined;
  }

  playerByCharacter(characterId: string): Player | undefined {
    return this.players.find((p) => p.characterId === characterId);
  }

  send(playerId: string, type: ServerMessageType, payload: unknown, ack?: string): void {
    this.player(playerId)?.conn?.send(type, payload, ack);
  }

  broadcast(type: ServerMessageType, payload: unknown): void {
    for (const p of this.players) p.conn?.send(type, payload);
  }

  lobbyPayload() {
    return {
      room_id: this.id,
      invite_code: this.code,
      host_player_id: this.hostId ?? "",
      phase: this.phase,
      settings: { ...this.settings },
      ...(this.resume ? { resume_save: { save_id: this.resume.saveId, name: this.resume.name } } : {}),
      players: this.players.map((p) => ({
        player_id: p.id,
        display_name: p.name,
        status: p.status,
        ready: p.ready,
        character_id: p.characterId,
      })),
    };
  }

  castPayload(): { entries: CastEntry[] } {
    return {
      entries: this.cast.map((c) => ({
        asset_id: c.assetId, owner_player_id: c.ownerPlayerId, owner_name: this.player(c.ownerPlayerId)?.name ?? "A player",
        name: c.name, role_hint: c.roleHint, concept: c.concept, recipe: c.recipe, status: c.status,
      })),
    };
  }

  broadcastCast(): void {
    this.broadcast("cast_state", this.castPayload());
  }

  /** What the DM may use right now: approved, npc or enemy, with the room's cast and painting settings applied. */
  usableCast(kind?: "npc" | "enemy"): CastItem[] {
    if ((this.settings.custom_cast ?? "host_approval") === "off") return [];
    const paintings = this.settings.custom_paintings !== false;
    return this.cast.filter((c) => c.status === "approved" && (c.roleHint === "npc" || c.roleHint === "enemy") && (!kind || c.roleHint === kind) && (paintings || c.recipe.kind !== "pixel"));
  }

  broadcastLobby(): void {
    this.broadcast("lobby_state", this.lobbyPayload());
  }

  setStatus(p: Player, status: PlayerStatus): void {
    if (p.status === status) return;
    p.status = status;
    this.broadcast("presence", { player_id: p.id, status });
    this.broadcastLobby();
    this.game?.onPresenceChanged(p);
  }

  anyConnected(): boolean {
    return this.players.some((p) => p.conn?.open);
  }
}

export class RoomRegistry {
  private readonly byId = new Map<string, Room>();
  private readonly byCode = new Map<string, Room>();
  private counter = 0;

  constructor(private readonly deps: Pick<Deps, "random">) {}

  get size(): number {
    return this.byId.size;
  }

  all(): Room[] {
    return [...this.byId.values()];
  }

  get(id: string): Room | undefined {
    return this.byId.get(id);
  }

  findByCode(code: string): Room | undefined {
    return this.byCode.get(code.trim().toUpperCase());
  }

  create(conn: Conn): Room {
    let code = "";
    for (let attempt = 0; attempt < 200; attempt++) {
      code = "";
      for (let i = 0; i < INVITE_LENGTH; i++) {
        // the attempt number perturbs the stream so a constant injected random() still terminates
        const r = (this.deps.random() + (attempt * 0.6180339887) / 7) % 1;
        code += INVITE_ALPHABET[Math.floor(r * INVITE_ALPHABET.length)];
      }
      if (!this.byCode.has(code)) break;
    }
    if (this.byCode.has(code)) code = this.uniqueFallback();
    const id = `room_${++this.counter}_${Math.floor(this.deps.random() * 36 ** 4).toString(36)}`;
    const room = new Room(id, code, conn.id);
    this.byId.set(id, room);
    this.byCode.set(code, room);
    return room;
  }

  private uniqueFallback(): string {
    for (;;) {
      let code = "";
      for (let i = 0; i < INVITE_LENGTH; i++) code += INVITE_ALPHABET[randomBytes(1)[0]! % INVITE_ALPHABET.length];
      if (!this.byCode.has(code)) return code;
    }
  }

  remove(room: Room): void {
    this.byId.delete(room.id);
    this.byCode.delete(room.code);
  }
}

export function newToken(): string {
  return randomBytes(18).toString("base64url");
}
