import { addCharacter, cloneState, validatePointBuy } from "@aedm/engine";
import type { CharacterCreate, ClientMessage } from "@aedm/schemas";
import { AccountHandlers } from "./accounts/handlers";
import { forgeCharacterAbilities, ForgeError } from "./forge";
import { GameSession, type Reply } from "./game";
import type { Conn } from "./net";
import { newToken, Room, RoomRegistry, type Player } from "./rooms";
import { readSave, readSaveExact } from "./saves";
import type { Deps } from "./types";

type Msg<T extends ClientMessage["type"]> = Extract<ClientMessage, { type: T }>;

/** Everything that happens when a validated client message arrives. */
export class Handlers {
  readonly registry: RoomRegistry;
  private readonly accounts: AccountHandlers;

  constructor(private readonly deps: Deps) {
    this.registry = new RoomRegistry(deps);
    this.accounts = new AccountHandlers(deps, this.registry, { onRoomCreated: (room) => this.scheduleIdleCheck(room) });
  }

  private get cfg() { return this.deps.config; }

  // ---------- entry ----------

  async dispatch(conn: Conn, msg: ClientMessage): Promise<void> {
    const ack = msg.id;
    switch (msg.type) {
      case "ping": conn.send("pong", {}, ack); return;
      case "create_room": return this.createRoom(conn, msg as Msg<"create_room">);
      case "join_room": return this.joinRoom(conn, msg as Msg<"join_room">);
      default: break;
    }
    if (this.accounts.handles(msg.type)) return this.accounts.dispatch(conn, msg);
    const room = conn.roomId ? this.registry.get(conn.roomId) : undefined;
    const player = room?.player(conn.playerId);
    if (!room || !player) return conn.error("forbidden", "Join a room first.", ack);

    const reply: Reply = (kind, code, message) => {
      if (kind === "ok") conn.send("presence", { player_id: player.id, status: player.status }, ack);
      else conn.error(code ?? "invalid_state", message ?? "That did not work.", ack);
    };

    switch (msg.type) {
      case "set_ready": return this.setReady(room, player, msg as Msg<"set_ready">, reply);
      case "update_settings": return this.updateSettings(room, player, msg as Msg<"update_settings">, reply);
      case "start_game": return this.startGame(room, player, reply);
      case "claim_character": return this.claimCharacter(room, player, conn, msg as Msg<"claim_character">, reply);
      case "say": return this.say(room, player, msg as Msg<"say">, reply);
      case "request_save": return this.requestSave(room, player, conn, msg as Msg<"request_save">, reply);
      case "load_save": return this.loadSave(room, player, msg as Msg<"load_save">, reply);
      default: break;
    }

    const game = room.game;
    if (!game) return reply("error", "invalid_state", "The game has not started.");
    switch (msg.type) {
      case "move_intent": game.handleMove(player, (msg as Msg<"move_intent">).payload, reply); return;
      case "act": {
        const p = (msg as Msg<"act">).payload;
        game.handleAct(player, p.verb, p.target_id, reply);
        return;
      }
      case "basic_attack": game.handleBasicAttack(player, (msg as Msg<"basic_attack">).payload.target_id, reply); return;
      case "use_ability": {
        const p = (msg as Msg<"use_ability">).payload;
        game.handleUseAbility(player, p.ability_id, p.target, reply);
        return;
      }
      case "use_item": {
        const p = (msg as Msg<"use_item">).payload;
        game.handleUseItem(player, p.item_id, p.target, reply);
        return;
      }
      case "end_turn": game.handleEndTurn(player, reply); return;
      case "vote_cast": {
        const p = (msg as Msg<"vote_cast">).payload;
        game.handleVote(player, p.vote_id, p.choice, reply);
        return;
      }
      default: return;
    }
  }

  // ---------- rooms ----------

  private createRoom(conn: Conn, msg: Msg<"create_room">): void {
    if (conn.roomId) return conn.error("invalid_state", "You are already in a room.", msg.id);
    const room = this.registry.create(conn);
    this.scheduleIdleCheck(room);
    conn.send("room_created", { room_id: room.id, invite_code: room.code }, msg.id);
  }

  private joinRoom(conn: Conn, msg: Msg<"join_room">): void {
    const { invite_code, display_name, auth_token } = msg.payload;
    const room = this.registry.findByCode(invite_code);
    if (!room) return conn.error("not_found", "No room with that invite code.", msg.id);
    if (conn.roomId && conn.roomId !== room.id) return conn.error("invalid_state", "You are already in another room.", msg.id);

    let player = auth_token ? room.playerByToken(auth_token) : undefined;
    if (!player && conn.playerId) player = room.player(conn.playerId); // same connection asking for a fresh state
    if (!player) player = room.playerByUser(conn.userId); // a logged-in user is rebound without the room token
    if (player) {
      // reconnect (or resync) with the same seat
      if (player.conn && player.conn !== conn) {
        player.conn.playerId = null;
        player.conn.roomId = null;
        player.conn.close();
      }
      this.deps.timers.clearTimeout(player.graceTimer);
      player.graceTimer = null;
      player.userId ??= conn.userId;
      player.conn = conn;
      conn.playerId = player.id;
      conn.roomId = room.id;
    } else {
      if (room.players.length === 0 && conn.id !== room.creatorConnId) {
        return conn.error("not_found", "No room with that invite code.", msg.id);
      }
      if (room.phase !== "lobby") return conn.error("invalid_state", "That game has already started.", msg.id);
      if (room.players.length >= this.cfg.maxPlayers) return conn.error("invalid_state", "That room is full.", msg.id);
      player = {
        id: `p_${room.players.length + 1}_${Math.floor(this.deps.random() * 36 ** 4).toString(36)}`,
        name: this.uniqueName(room, display_name),
        token: newToken(),
        userId: conn.userId,
        conn,
        status: "online",
        ready: false,
        characterId: null,
        forging: false,
        graceTimer: null,
      };
      room.players.push(player);
      if (room.hostId === null) room.hostId = player.id;
      conn.playerId = player.id;
      conn.roomId = room.id;
    }

    this.deps.timers.clearTimeout(room.idleTimer);
    room.idleTimer = null;
    conn.send("joined", { player_id: player.id, auth_token: player.token, room_id: room.id }, msg.id);
    if (player.status !== "online") room.setStatus(player, "online");
    room.broadcastLobby();
    room.game?.sendFullState(player.id);
  }

  private uniqueName(room: Room, wanted: string): string {
    const taken = new Set(room.players.map((p) => p.name.toLowerCase()));
    if (!taken.has(wanted.toLowerCase())) return wanted;
    for (let n = 2; n < 20; n++) {
      const candidate = `${wanted.slice(0, 24 - String(n).length - 1)} ${n}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return wanted;
  }

  onClose(conn: Conn): void {
    const room = conn.roomId ? this.registry.get(conn.roomId) : undefined;
    const player = room?.player(conn.playerId);
    if (!room || !player || player.conn !== conn) return;
    player.conn = null;
    this.deps.timers.clearTimeout(player.graceTimer);
    player.graceTimer = this.deps.timers.setTimeout(() => {
      player.graceTimer = null;
      if (player.conn) return;
      if (player.status !== "autopilot") room.setStatus(player, "offline");
      if (!room.anyConnected()) this.scheduleIdleCheck(room);
    }, this.cfg.disconnectGraceMs);
    // keep the seat; the grace timer marks it offline
  }

  private scheduleIdleCheck(room: Room): void {
    this.deps.timers.clearTimeout(room.idleTimer);
    room.idleTimer = this.deps.timers.setTimeout(() => {
      if (room.anyConnected()) return;
      void room.game?.close();
      this.registry.remove(room);
    }, this.cfg.roomIdleMs);
  }

  async shutdown(): Promise<void> {
    for (const room of this.registry.all()) {
      this.deps.timers.clearTimeout(room.idleTimer);
      for (const p of room.players) this.deps.timers.clearTimeout(p.graceTimer);
      await room.game?.close();
    }
  }

  // ---------- lobby ----------

  private setReady(room: Room, player: Player, msg: Msg<"set_ready">, reply: Reply): void {
    if (room.phase !== "lobby") return reply("error", "invalid_state", "The game has already started.");
    if (player.forging) return reply("error", "invalid_state", "Your character is still being forged.");
    if (msg.payload.ready && !player.characterId) return reply("error", "invalid_state", "Create your character before readying up.");
    player.ready = msg.payload.ready;
    reply("ok");
    room.broadcastLobby();
  }

  private updateSettings(room: Room, player: Player, msg: Msg<"update_settings">, reply: Reply): void {
    if (player.id !== room.hostId) return reply("error", "not_host", "Only the host can change settings.");
    if (room.phase !== "lobby") return reply("error", "invalid_state", "The game has already started.");
    room.settings = { ...room.settings, ...msg.payload };
    reply("ok");
    room.broadcastLobby();
  }

  private say(room: Room, player: Player, msg: Msg<"say">, reply: Reply): void {
    const { text, channel } = msg.payload;
    if (room.game) {
      room.game.handleSay(player, text, channel);
    } else {
      room.broadcast("chat", { from_id: player.id, from_name: player.name, channel, text });
    }
    reply("ok");
  }

  private async claimCharacter(room: Room, player: Player, conn: Conn, msg: Msg<"claim_character">, reply: Reply): Promise<void> {
    if (room.phase !== "lobby") return reply("error", "invalid_state", "The game has already started.");
    if (player.forging) return reply("error", "invalid_state", "Your character is already being forged.");
    const p = msg.payload;

    if (p.character_id !== "new" && p.character_id !== "template") {
      const ch = room.scratch.characters[p.character_id];
      const owner = room.playerByCharacter(p.character_id);
      if (!ch) return reply("error", "not_found", "No such character.");
      if (owner && owner.id !== player.id) return reply("error", "forbidden", "Another player has that character.");
      player.characterId = ch.id;
      player.ready = false;
      conn.send("character_claimed", { character_id: ch.id, player_id: player.id }, msg.id);
      room.broadcast("character_claimed", { character_id: ch.id, player_id: player.id });
      room.broadcastLobby();
      return;
    }

    let create: CharacterCreate;
    let templateId: string | undefined;
    if (p.character_id === "template" && "template_id" in p) {
      const tpl = await this.accounts.loadTemplate(conn, p.template_id);
      if (!tpl) return reply("error", "not_found", "No such saved character. Log in to use your saved characters.");
      create = tpl.character;
      templateId = tpl.id;
    } else {
      if (!("character" in p)) return reply("error", "bad_message", "Missing character.");
      create = p.character;
    }
    const pb = validatePointBuy(create.scores);
    if (!pb.ok) return reply("error", "invalid_state", pb.errors.join(" "));
    const lowerName = create.name.toLowerCase();
    const clash = room.players.some((o) => o.id !== player.id && o.characterId && room.scratch.characters[o.characterId]?.name.toLowerCase() === lowerName);
    if (clash) return reply("error", "invalid_state", "Another character at this table already has that name.");

    player.forging = true;
    player.ready = false;
    room.broadcastLobby();
    try {
      const forged = await forgeCharacterAbilities(this.deps.provider, create, {
        sleep: (ms) => new Promise((r) => { this.deps.timers.setTimeout(() => r(), ms); }),
        retryBackoffMs: this.cfg.retryBackoffMs,
      });
      const { ability_texts: _t, abilities: _a, ...rest } = create;
      const scratch = cloneState(room.scratch);
      if (player.characterId) delete scratch.characters[player.characterId];
      const added = addCharacter(scratch, { ...rest, abilities: forged.abilities }, player.id);
      if (!added.ok) {
        reply("error", "invalid_state", `The character was refused: ${added.errors.join("; ")}`);
        return;
      }
      room.scratch = added.state;
      player.characterId = added.character.id;
      await this.accounts.afterForge(conn, create, forged.abilities, templateId);
      conn.send("character_claimed", { character_id: added.character.id, player_id: player.id }, msg.id);
      room.broadcast("character_claimed", { character_id: added.character.id, player_id: player.id });
      for (const line of forged.notices) conn.send("log", { kind: "system", text: line });
    } catch (err) {
      reply("error", "invalid_state", err instanceof ForgeError ? err.message : "Something went wrong forging your character.");
      if (!(err instanceof ForgeError)) this.deps.logger.error("[claim] failed:", err instanceof Error ? err.message : String(err));
    } finally {
      player.forging = false;
      room.broadcastLobby();
    }
  }

  private async startGame(room: Room, player: Player, reply: Reply): Promise<void> {
    if (player.id !== room.hostId) return reply("error", "not_host", "Only the host can start the game.");
    if (room.phase !== "lobby" || room.starting) return reply("error", "invalid_state", "The game has already started.");
    if (room.players.some((p) => p.forging)) return reply("error", "invalid_state", "Wait for every character to finish forging.");
    if (!player.characterId) return reply("error", "invalid_state", "Create your character first.");
    const solo = room.settings.dev_solo;
    const participants = room.players.filter((p) => p.characterId && (solo || p.ready || p.id === room.hostId));
    if (!solo && participants.length < 2) return reply("error", "invalid_state", "At least two players must be ready.");

    room.starting = true;
    reply("ok");
    room.broadcast("log", { kind: "system", text: "The DM is preparing the campaign…" });
    const game = new GameSession(room, this.deps);
    try {
      await game.initialize(participants);
    } catch (err) {
      room.starting = false;
      await game.close();
      this.deps.logger.error("[start] failed:", err instanceof Error ? err.message : String(err));
      room.send(player.id, "error", { code: "invalid_state", message: "The DM could not prepare the campaign. Try again." });
      return;
    }
    for (const p of room.players) {
      if (!participants.includes(p)) { p.characterId = null; p.ready = false; }
    }
    room.game = game;
    room.phase = "playing";
    room.starting = false;
    room.broadcastLobby();
    game.begin();
  }

  // ---------- saves ----------

  private async requestSave(room: Room, player: Player, conn: Conn, msg: Msg<"request_save">, reply: Reply): Promise<void> {
    const game = room.game;
    if (!game) return reply("error", "invalid_state", "There is nothing to save yet.");
    try {
      const id = await game.saveNamed(msg.payload.name);
      room.broadcast("save_created", { save_id: id, name: msg.payload.name });
      conn.send("presence", { player_id: player.id, status: player.status }, msg.id);
    } catch (err) {
      this.deps.logger.error("[save] failed:", err instanceof Error ? err.message : String(err));
      reply("error", "invalid_state", "The save could not be written.");
    }
  }

  private async loadSave(room: Room, player: Player, msg: Msg<"load_save">, reply: Reply): Promise<void> {
    if (player.id !== room.hostId) return reply("error", "not_host", "Only the host can load a save.");
    const from = room.resume && room.resume.saveId === msg.payload.save_id ? room.resume : null;
    const save = from
      ? await readSaveExact(this.deps.saveDir, from.roomId, from.saveId)
      : await readSave(this.deps.saveDir, room.id, msg.payload.save_id);
    if (!save) return reply("error", "not_found", "No such save.");
    // a campaign saved by an account can only be loaded by that account
    if (save.owner_user_id && save.owner_user_id !== player.userId) return reply("error", "not_found", "No such save.");
    room.resume = null;
    reply("ok");
    let game = room.game;
    if (!game) {
      game = new GameSession(room, this.deps);
      room.game = game;
      room.phase = "playing";
    }
    const g = game;
    await g.enqueue(() => {
      g.restore(save);
      room.broadcastLobby();
    });
  }
}
